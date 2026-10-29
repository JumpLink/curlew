/**
 * The real {@link OmemoStorage}: `@curlew/omemo`'s storage port over the account's secret file.
 *
 * `@curlew/omemo` is pure by design (ADR 0006 §2) — it declares what it needs to persist and
 * nothing about where. This is the other half: one `SecretStore` namespace per record kind, every
 * value a JSON string, because the file holds TEXT only (see `@curlew/store`'s AGENTS.md (c):
 * parameters are interpolated, so a BLOB would not survive the round trip).
 *
 * Three properties are load-bearing rather than incidental:
 *
 *  - **No caching.** Every read goes to the file. The port forbids a cache in so many words, and
 *    the reason is ADR 0006 §4: a cached session is a forked ratchet the moment `curlew sync` and
 *    the daemon are both running, and a forked ratchet loses messages for good.
 *  - **{@link SecretStoreOmemoStorage.transaction} is the file's write lock**, not a local mutex.
 *    `BEGIN IMMEDIATE` is what the OTHER process queues on, which is the whole point.
 *  - **Writes go through `apply`,** which is reentrant inside a transaction, so a ratchet step is
 *    load → step → save with no window in between.
 *
 * Key material never leaves here in the clear: this module reads and writes base64 the way
 * `@curlew/omemo` hands it over, and no value it touches is ever logged or put in an error
 * message. An id is fine; a private key is not.
 */

import {
  addressKey,
  type DeviceAddress,
  type DeviceListRecord,
  type DeviceRecord,
  type IdentityRecord,
  type OmemoStorage,
  type SessionRecord,
  type StoredPreKey,
  type StoredSignedPreKey,
} from '@curlew/omemo';
import type { SecretChange, SecretStore } from '@curlew/store';
import type { JournalEntry, PlaintextJournal } from './omemo-archive.ts';

/** Our own device: identity key, device id, and the two counters that must outlive the keys. */
const DEVICE_NAMESPACE = 'omemo.device';
/** Our signed prekeys, current and retained, by id. */
const SIGNED_PREKEY_NAMESPACE = 'omemo.signed-prekey';
/** Our one-time prekeys by id, consumed ones included until their deletion is safe. */
const PREKEY_NAMESPACE = 'omemo.prekey';
/** One session per remote device, by `<jid>:<device id>`. */
const SESSION_NAMESPACE = 'omemo.session';
/** What we know about a remote device's identity key, by `<jid>:<device id>`. */
const IDENTITY_NAMESPACE = 'omemo.identity';
/** A JID's cached device list, by bare JID. */
const DEVICE_LIST_NAMESPACE = 'omemo.devices';
/** Decrypted bodies by archive id, until the index holds them — see `omemo-archive.ts`. */
const PLAINTEXT_NAMESPACE = 'omemo.plaintext';

/**
 * The key names inside each namespace, from ADR 0006 §3's table.
 *
 * Spelled out as constants because they are a FILE FORMAT: an account file written by one
 * version is read by the next, so renaming one of these silently turns an existing device into
 * an unregistered one — which republishes a new device id and makes every peer's client
 * encrypt for a device whose predecessor's sessions are gone.
 *
 * The two counters sit in the namespace they count, not beside the device record: `current` is
 * which signed prekey the bundle advertises, `next-id` is the prekey id to hand out next. Both
 * are skipped by the id listings, which take only numeric keys.
 */
const DEVICE_ID = 'id';
const IDENTITY_PRIVATE_KEY = 'identity';
const REGISTRATION_ID = 'registration';
const CURRENT_SIGNED_PREKEY_ID = 'current';
const NEXT_PREKEY_ID = 'next-id';

/** Every namespace this adapter owns — what `curlew omemo reset` would clear. */
export const OMEMO_NAMESPACES: readonly string[] = [
  DEVICE_NAMESPACE,
  SIGNED_PREKEY_NAMESPACE,
  PREKEY_NAMESPACE,
  SESSION_NAMESPACE,
  IDENTITY_NAMESPACE,
  DEVICE_LIST_NAMESPACE,
  PLAINTEXT_NAMESPACE,
];

/**
 * An {@link OmemoStorage} on one account's `SecretStore`.
 *
 * The store is borrowed, not owned: the backend opens the account file once and hands it over, so
 * nothing here closes it.
 */
export class SecretStoreOmemoStorage implements OmemoStorage, PlaintextJournal {
  readonly #store: SecretStore;

  constructor(store: SecretStore) {
    this.#store = store;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.#store.transaction(fn);
  }

  // -- our own device -------------------------------------------------------------------------

  async loadDevice(): Promise<DeviceRecord | undefined> {
    const fields = this.#store.load(DEVICE_NAMESPACE);
    const deviceId = Number(fields.get(DEVICE_ID));
    const identityPrivateKey = fields.get(IDENTITY_PRIVATE_KEY);
    if (!Number.isInteger(deviceId) || deviceId < 1 || identityPrivateKey === undefined) return undefined;
    return { deviceId, identityPrivateKey, registrationId: Number(fields.get(REGISTRATION_ID) ?? 0) };
  }

  async saveDevice(record: DeviceRecord): Promise<void> {
    this.#store.apply([
      put(DEVICE_NAMESPACE, DEVICE_ID, String(record.deviceId)),
      put(DEVICE_NAMESPACE, IDENTITY_PRIVATE_KEY, record.identityPrivateKey),
      put(DEVICE_NAMESPACE, REGISTRATION_ID, String(record.registrationId)),
    ]);
  }

  // -- signed prekeys -------------------------------------------------------------------------

  async loadSignedPreKey(id: number): Promise<StoredSignedPreKey | undefined> {
    const stored = parse<Omit<StoredSignedPreKey, 'id'>>(this.#store.get(SIGNED_PREKEY_NAMESPACE, String(id)));
    return stored === undefined ? undefined : { id, ...stored };
  }

  async loadCurrentSignedPreKeyId(): Promise<number | undefined> {
    const raw = this.#store.get(SIGNED_PREKEY_NAMESPACE, CURRENT_SIGNED_PREKEY_ID);
    if (raw === null) return undefined;
    const id = Number(raw);
    return Number.isInteger(id) ? id : undefined;
  }

  async saveSignedPreKey(record: StoredSignedPreKey, current: boolean): Promise<void> {
    const { id, ...rest } = record;
    const changes = [put(SIGNED_PREKEY_NAMESPACE, String(id), JSON.stringify(rest))];
    if (current) changes.push(put(SIGNED_PREKEY_NAMESPACE, CURRENT_SIGNED_PREKEY_ID, String(id)));
    this.#store.apply(changes);
  }

  async deleteSignedPreKey(id: number): Promise<void> {
    const changes = [drop(SIGNED_PREKEY_NAMESPACE, String(id))];
    // Clearing the pointer too: a `currentSignedPreKeyId` naming a key that is gone would make
    // the next bundle build fail rather than rotate.
    if ((await this.loadCurrentSignedPreKeyId()) === id) {
      changes.push(drop(SIGNED_PREKEY_NAMESPACE, CURRENT_SIGNED_PREKEY_ID));
    }
    this.#store.apply(changes);
  }

  async listSignedPreKeyIds(): Promise<number[]> {
    return ids(this.#store.load(SIGNED_PREKEY_NAMESPACE).keys());
  }

  // -- one-time prekeys -----------------------------------------------------------------------

  async loadPreKey(id: number): Promise<StoredPreKey | undefined> {
    const stored = parse<Omit<StoredPreKey, 'id'>>(this.#store.get(PREKEY_NAMESPACE, String(id)));
    return stored === undefined ? undefined : { id, ...stored };
  }

  async savePreKeys(records: readonly StoredPreKey[]): Promise<void> {
    this.#store.apply(
      records.map(({ id, ...rest }) => put(PREKEY_NAMESPACE, String(id), JSON.stringify(rest))),
    );
  }

  async deletePreKey(id: number): Promise<void> {
    this.#store.apply([drop(PREKEY_NAMESPACE, String(id))]);
  }

  async markPreKeyConsumed(id: number, at: string): Promise<void> {
    const existing = await this.loadPreKey(id);
    if (existing === undefined) return;
    await this.savePreKeys([{ ...existing, consumedAt: at }]);
  }

  async listPreKeyIds(): Promise<number[]> {
    return ids(this.#store.load(PREKEY_NAMESPACE).keys());
  }

  /**
   * Hand out `count` ids and move the counter past them.
   *
   * The counter is stored rather than derived from the stored keys, because an id must not come
   * round again after its prekey was deleted: a peer that still holds an old bundle would
   * otherwise be answered with a key exchange for the wrong key.
   */
  async reservePreKeyIds(count: number): Promise<number> {
    const raw = Number(this.#store.get(PREKEY_NAMESPACE, NEXT_PREKEY_ID));
    const first = Number.isInteger(raw) && raw >= 1 ? raw : 1;
    this.#store.apply([put(PREKEY_NAMESPACE, NEXT_PREKEY_ID, String(first + count))]);
    return first;
  }

  // -- sessions -------------------------------------------------------------------------------

  async loadSession(address: DeviceAddress): Promise<SessionRecord | undefined> {
    return parse<SessionRecord>(this.#store.get(SESSION_NAMESPACE, addressKey(address)));
  }

  async saveSession(address: DeviceAddress, record: SessionRecord): Promise<void> {
    this.#store.apply([put(SESSION_NAMESPACE, addressKey(address), JSON.stringify(record))]);
  }

  async deleteSession(address: DeviceAddress): Promise<void> {
    this.#store.apply([drop(SESSION_NAMESPACE, addressKey(address))]);
  }

  async listSessionAddresses(jid?: string): Promise<DeviceAddress[]> {
    return addresses(this.#store.load(SESSION_NAMESPACE).keys(), jid);
  }

  // -- remote identities ----------------------------------------------------------------------

  async loadIdentity(address: DeviceAddress): Promise<IdentityRecord | undefined> {
    return parse<IdentityRecord>(this.#store.get(IDENTITY_NAMESPACE, addressKey(address)));
  }

  async saveIdentity(address: DeviceAddress, record: IdentityRecord): Promise<void> {
    this.#store.apply([put(IDENTITY_NAMESPACE, addressKey(address), JSON.stringify(record))]);
  }

  async listIdentities(jid: string): Promise<{ address: DeviceAddress; record: IdentityRecord }[]> {
    const rows = this.#store.load(IDENTITY_NAMESPACE);
    const out: { address: DeviceAddress; record: IdentityRecord }[] = [];
    for (const address of addresses(rows.keys(), jid)) {
      const record = parse<IdentityRecord>(rows.get(addressKey(address)) ?? null);
      if (record !== undefined) out.push({ address, record });
    }
    return out;
  }

  /**
   * Every JID this account has an identity key for, ascending.
   *
   * Beyond the port, because `OmemoStorage` only ever asks about a JID it already holds. The
   * listing is what `curlew omemo devices` needs with no argument: whose keys are in this file.
   */
  async listIdentityJids(): Promise<string[]> {
    const jids = new Set(addresses(this.#store.load(IDENTITY_NAMESPACE).keys(), undefined).map((a) => a.jid));
    return [...jids].sort((a, b) => a.localeCompare(b));
  }

  // -- device lists ---------------------------------------------------------------------------

  async loadDeviceList(jid: string): Promise<DeviceListRecord | undefined> {
    return parse<DeviceListRecord>(this.#store.get(DEVICE_LIST_NAMESPACE, jid));
  }

  async saveDeviceList(jid: string, record: DeviceListRecord): Promise<void> {
    this.#store.apply([put(DEVICE_LIST_NAMESPACE, jid, JSON.stringify(record))]);
  }

  // -- the plaintext journal ------------------------------------------------------------------

  async loadPlaintext(archiveId: string): Promise<JournalEntry | undefined> {
    return parse<JournalEntry>(this.#store.get(PLAINTEXT_NAMESPACE, archiveId));
  }

  async savePlaintext(archiveId: string, entry: JournalEntry): Promise<void> {
    this.#store.apply([put(PLAINTEXT_NAMESPACE, archiveId, JSON.stringify(entry))]);
  }

  /**
   * An entry whose `at` does not parse is dropped too: it can never be shown to be recent, and
   * keeping it would mean a row that outlives every retention window there is.
   */
  async prunePlaintext(before: string): Promise<void> {
    const cutoff = Date.parse(before);
    if (!Number.isFinite(cutoff)) return;
    const changes: SecretChange[] = [];
    for (const [archiveId, raw] of this.#store.load(PLAINTEXT_NAMESPACE)) {
      const at = Date.parse(parse<JournalEntry>(raw)?.at ?? '');
      if (!Number.isFinite(at) || at < cutoff) changes.push(drop(PLAINTEXT_NAMESPACE, archiveId));
    }
    if (changes.length > 0) this.#store.apply(changes);
  }
}

function put(namespace: string, key: string, value: string): SecretChange {
  return { namespace, key, value };
}

function drop(namespace: string, key: string): SecretChange {
  return { namespace, key, value: null };
}

/**
 * A stored JSON record, or `undefined` for a missing one.
 *
 * A row that does not parse is treated as missing rather than thrown over. The caller's answer to
 * "no session" is to build one; its answer to an exception is to fail the whole receive, and a
 * single corrupt row should not stop an account from syncing.
 */
function parse<T>(raw: string | null): T | undefined {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** The numeric keys of a namespace, ascending. */
function ids(keys: Iterable<string>): number[] {
  const out: number[] = [];
  for (const key of keys) {
    const id = Number(key);
    if (Number.isInteger(id)) out.push(id);
  }
  return out.sort((a, b) => a - b);
}

/** The addresses a namespace is keyed by, optionally restricted to one JID, in a stable order. */
function addresses(keys: Iterable<string>, jid: string | undefined): DeviceAddress[] {
  const out: DeviceAddress[] = [];
  for (const key of keys) {
    // Not `parseAddressKey`: a stored key is ours, and a row that fails its range checks should
    // still be listed so that `curlew omemo devices` can show what is in the file.
    const split = key.lastIndexOf(':');
    if (split <= 0) continue;
    const address = { jid: key.slice(0, split), deviceId: Number(key.slice(split + 1)) };
    if (!Number.isInteger(address.deviceId)) continue;
    if (jid === undefined || address.jid === jid) out.push(address);
  }
  return out.sort((a, b) => a.jid.localeCompare(b.jid) || a.deviceId - b.deviceId);
}
