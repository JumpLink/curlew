/**
 * The storage port: everything this package needs to persist, as an interface it does not
 * implement.
 *
 * `@curlew/omemo` is pure (ADR 0006 §2) — no `SecretStore`, no SQLite, no `gi://`. The real
 * implementation lives in `@curlew/xmpp` over the account's secret file; what is here is the
 * contract plus {@link MemoryOmemoStorage}, which the tests run against.
 *
 * Two things about the shape are decisions rather than taste:
 *
 *  - **Everything is `async`.** The backing store is a file, and a synchronous port would force
 *    the adapter to either block or cache — and a cached session is the exact fork ADR 0006 §4
 *    forbids.
 *  - **{@link OmemoStorage.transaction} exists.** A ratchet step is load → step → save, and two
 *    curlew processes share one account. Without a way to say "these three operations are one",
 *    `curlew send` and the daemon can both load the same session, step it, and write back
 *    states that each lost the other's messages. The in-memory implementation is single-threaded
 *    and so needs only to serialize, but it still does — a test that passes because nothing
 *    overlaps would not say anything about the real one.
 *
 * Byte values are base64 strings throughout, matching what `SecretStore` can hold.
 */

import { addressKey, type DeviceAddress, type DeviceId, type TrustState } from './types.ts';
import type { SessionRecord } from './session.ts';

/** This device's own long-lived identity. */
export interface DeviceRecord {
  /** Our device id as published in the device list. */
  readonly deviceId: DeviceId;
  /** Our identity private key, base64. The public half is derived from it. */
  readonly identityPrivateKey: string;
  /** libsignal's registration id. Stored because the bundle format has a slot for it. */
  readonly registrationId: number;
}

/** One of our signed prekeys, current or the retained previous one. */
export interface StoredSignedPreKey {
  /** The id the bundle advertises it under. */
  readonly id: number;
  /** Its private key, base64. */
  readonly privateKey: string;
  /** Our identity key's signature over its encoded public half, base64. */
  readonly signature: string;
  /** When it was generated, ISO 8601 — what the 7-day rotation is measured from. */
  readonly createdAt: string;
}

/** One of our one-time prekeys. */
export interface StoredPreKey {
  /** The id the bundle advertises it under. */
  readonly id: number;
  /** Its private key, base64. */
  readonly privateKey: string;
  /**
   * When a key exchange consumed it, ISO 8601, while its deletion is deferred.
   *
   * Deferred rather than immediate during a MAM catch-up (ADR 0006 §3): the same prekey may
   * appear in several archived exchanges, and deleting it on the first would make the rest
   * undecryptable.
   */
  readonly consumedAt?: string | undefined;
}

/** What we know about one remote device's identity. */
export interface IdentityRecord {
  /** Its identity public key, base64. */
  readonly publicKey: string;
  /** How much it is trusted. */
  readonly trust: TrustState;
  /** When we first saw this key, ISO 8601. */
  readonly firstSeen: string;
}

/** A cached device list for one JID. */
export interface DeviceListRecord {
  /** The device ids the JID published. */
  readonly deviceIds: readonly DeviceId[];
  /** When it was fetched, ISO 8601 — the one-hour refresh is measured from this. */
  readonly fetchedAt: string;
}

/**
 * Everything `@curlew/omemo` persists.
 *
 * Implementations may assume every call happens inside a {@link OmemoStorage.transaction} when
 * the caller needs atomicity, and must not add caching of their own.
 */
export interface OmemoStorage {
  /** Run `fn` so that no other caller on this store observes a half-finished state. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  /** Our own device record, or `undefined` before this account has become a device. */
  loadDevice(): Promise<DeviceRecord | undefined>;
  /** Store our own device record. */
  saveDevice(record: DeviceRecord): Promise<void>;

  /** The signed prekey under `id`, current or retained. */
  loadSignedPreKey(id: number): Promise<StoredSignedPreKey | undefined>;
  /** The id of the signed prekey the bundle currently advertises. */
  loadCurrentSignedPreKeyId(): Promise<number | undefined>;
  /** Store a signed prekey; `current` makes it the one the bundle advertises. */
  saveSignedPreKey(record: StoredSignedPreKey, current: boolean): Promise<void>;
  /** Forget a signed prekey that is past its retention period. */
  deleteSignedPreKey(id: number): Promise<void>;
  /** Every signed prekey id we still hold, ascending. */
  listSignedPreKeyIds(): Promise<number[]>;

  /** The one-time prekey under `id`, consumed or not. */
  loadPreKey(id: number): Promise<StoredPreKey | undefined>;
  /** Store one-time prekeys. */
  savePreKeys(records: readonly StoredPreKey[]): Promise<void>;
  /** Delete a one-time prekey for good. */
  deletePreKey(id: number): Promise<void>;
  /** Mark a prekey consumed while its deletion is deferred. */
  markPreKeyConsumed(id: number, at: string): Promise<void>;
  /** Every one-time prekey id we hold, ascending, including consumed ones. */
  listPreKeyIds(): Promise<number[]>;
  /**
   * Reserve `count` fresh prekey ids and return the first.
   *
   * Reserving rather than asking for a maximum: ids must not be reused even after the prekey is
   * deleted, so the counter has to persist independently of which keys exist.
   */
  reservePreKeyIds(count: number): Promise<number>;

  /** The session with one device. */
  loadSession(address: DeviceAddress): Promise<SessionRecord | undefined>;
  /** Store the session with one device. */
  saveSession(address: DeviceAddress, record: SessionRecord): Promise<void>;
  /** Drop a session — what `curlew omemo reset` does. */
  deleteSession(address: DeviceAddress): Promise<void>;
  /** Every device we have a session with, optionally restricted to one JID. */
  listSessionAddresses(jid?: string): Promise<DeviceAddress[]>;

  /** What we know about one device's identity. */
  loadIdentity(address: DeviceAddress): Promise<IdentityRecord | undefined>;
  /** Store what we know about one device's identity. */
  saveIdentity(address: DeviceAddress, record: IdentityRecord): Promise<void>;
  /** Every device of `jid` whose identity we know, with its record. */
  listIdentities(jid: string): Promise<{ address: DeviceAddress; record: IdentityRecord }[]>;

  /** The cached device list for `jid`. */
  loadDeviceList(jid: string): Promise<DeviceListRecord | undefined>;
  /** Cache the device list for `jid`. */
  saveDeviceList(jid: string, record: DeviceListRecord): Promise<void>;
}

/**
 * An {@link OmemoStorage} in a `Map`, for tests and for a dry run.
 *
 * Nothing here is encrypted or persisted, so it is not an alternative to the real store — it is
 * the reference the tests check the protocol against without a SQLite file in the way.
 */
export class MemoryOmemoStorage implements OmemoStorage {
  #device: DeviceRecord | undefined;
  #currentSignedPreKeyId: number | undefined;
  #nextPreKeyId = 1;
  #lock: Promise<unknown> = Promise.resolve();
  readonly #signedPreKeys = new Map<number, StoredSignedPreKey>();
  readonly #preKeys = new Map<number, StoredPreKey>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #identities = new Map<string, IdentityRecord>();
  readonly #deviceLists = new Map<string, DeviceListRecord>();

  /**
   * Serialize `fn` against every other transaction on this store.
   *
   * Real serialization rather than just calling `fn`, so a test that interleaves two sessions
   * exercises the same ordering the SQLite implementation will enforce.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(fn, fn);
    // Swallow the rejection on the lock chain only; `run` still rejects for the caller.
    this.#lock = run.catch(() => undefined);
    return run;
  }

  async loadDevice(): Promise<DeviceRecord | undefined> {
    return this.#device;
  }

  async saveDevice(record: DeviceRecord): Promise<void> {
    this.#device = record;
  }

  async loadSignedPreKey(id: number): Promise<StoredSignedPreKey | undefined> {
    return this.#signedPreKeys.get(id);
  }

  async loadCurrentSignedPreKeyId(): Promise<number | undefined> {
    return this.#currentSignedPreKeyId;
  }

  async saveSignedPreKey(record: StoredSignedPreKey, current: boolean): Promise<void> {
    this.#signedPreKeys.set(record.id, record);
    if (current) this.#currentSignedPreKeyId = record.id;
  }

  async deleteSignedPreKey(id: number): Promise<void> {
    this.#signedPreKeys.delete(id);
    if (this.#currentSignedPreKeyId === id) this.#currentSignedPreKeyId = undefined;
  }

  async listSignedPreKeyIds(): Promise<number[]> {
    return [...this.#signedPreKeys.keys()].sort((a, b) => a - b);
  }

  async loadPreKey(id: number): Promise<StoredPreKey | undefined> {
    return this.#preKeys.get(id);
  }

  async savePreKeys(records: readonly StoredPreKey[]): Promise<void> {
    for (const record of records) this.#preKeys.set(record.id, record);
  }

  async deletePreKey(id: number): Promise<void> {
    this.#preKeys.delete(id);
  }

  async markPreKeyConsumed(id: number, at: string): Promise<void> {
    const existing = this.#preKeys.get(id);
    if (existing !== undefined) this.#preKeys.set(id, { ...existing, consumedAt: at });
  }

  async listPreKeyIds(): Promise<number[]> {
    return [...this.#preKeys.keys()].sort((a, b) => a - b);
  }

  async reservePreKeyIds(count: number): Promise<number> {
    const first = this.#nextPreKeyId;
    this.#nextPreKeyId += count;
    return first;
  }

  async loadSession(address: DeviceAddress): Promise<SessionRecord | undefined> {
    return this.#sessions.get(addressKey(address));
  }

  async saveSession(address: DeviceAddress, record: SessionRecord): Promise<void> {
    this.#sessions.set(addressKey(address), record);
  }

  async deleteSession(address: DeviceAddress): Promise<void> {
    this.#sessions.delete(addressKey(address));
  }

  async listSessionAddresses(jid?: string): Promise<DeviceAddress[]> {
    return collectAddresses(this.#sessions.keys(), jid);
  }

  async loadIdentity(address: DeviceAddress): Promise<IdentityRecord | undefined> {
    return this.#identities.get(addressKey(address));
  }

  async saveIdentity(address: DeviceAddress, record: IdentityRecord): Promise<void> {
    this.#identities.set(addressKey(address), record);
  }

  async listIdentities(jid: string): Promise<{ address: DeviceAddress; record: IdentityRecord }[]> {
    const out: { address: DeviceAddress; record: IdentityRecord }[] = [];
    for (const address of collectAddresses(this.#identities.keys(), jid)) {
      out.push({ address, record: this.#identities.get(addressKey(address))! });
    }
    return out;
  }

  async loadDeviceList(jid: string): Promise<DeviceListRecord | undefined> {
    return this.#deviceLists.get(jid);
  }

  async saveDeviceList(jid: string, record: DeviceListRecord): Promise<void> {
    this.#deviceLists.set(jid, record);
  }
}

function collectAddresses(keys: Iterable<string>, jid: string | undefined): DeviceAddress[] {
  const out: DeviceAddress[] = [];
  for (const key of keys) {
    const split = key.lastIndexOf(':');
    if (split <= 0) continue;
    const address = { jid: key.slice(0, split), deviceId: Number(key.slice(split + 1)) };
    if (jid === undefined || address.jid === jid) out.push(address);
  }
  return out.sort((a, b) => a.jid.localeCompare(b.jid) || a.deviceId - b.deviceId);
}
