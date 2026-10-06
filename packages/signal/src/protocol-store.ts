/**
 * libsignal's protocol stores on curlew's `SecretStore`: the session file of one Signal account.
 *
 * What it holds is everything this linked device is — the account's identity key pair, the
 * device's password and registration id, its signed, Kyber and one-time pre-keys, a session per
 * contact device, the identity key seen for each contact, and a sender key per group sender. Two
 * of curlew's own namespaces live here too: when a contact's safety number changed, and the
 * ledger of plaintexts this build could not map (Signal deletes an acknowledged envelope, so a
 * plaintext nobody could read would otherwise exist nowhere).
 * Whoever holds the file can read the account's incoming messages: it is SECRET (0600 in a 0700
 * directory, never logged, never in a DTO or MCP output).
 *
 * Writes are EXPLICIT and batched: every change lands in memory and marks its key dirty; `flush()`
 * writes all dirty keys in ONE `SecretStore.apply`. There is no timer. The receiver flushes at its
 * commit points — after the journal holds the decrypted messages and before it acknowledges the
 * envelopes — so an acknowledged message never leaves a ratchet step only in memory. That order
 * matters more here than for WhatsApp: curlew sends no retry requests, so a lost ratchet step
 * would leave a contact's later messages undecryptable. One apply per commit is also a few
 * statements rather than one per key, which is what makes a large flush cheap.
 *
 * The stores implement libsignal's abstract store classes structurally (libsignal bridges them by
 * shape, not by class), so this module needs libsignal only at run time, through `SignalLib`.
 */

import type { SetAsideLedger } from '@curlew/protocol';
import type { SecretChange, SecretStore } from '@curlew/store';
import type * as Core from '@signalapp/libsignal-client';
import type { SignalLib } from './lib.ts';

export const NS = {
  account: 'signal.account',
  session: 'signal.session',
  identity: 'signal.identity',
  preKey: 'signal.prekey',
  signedPreKey: 'signal.signedprekey',
  kyberPreKey: 'signal.kyberprekey',
  kyberUsed: 'signal.kyberused',
  identityChanged: 'signal.identitychanged',
  senderKey: 'signal.senderkey',
} as const;

/** curlew's own namespace in the same file: which account this is, for `accounts list`. */
export const ACCOUNT_NAMESPACE = 'postbote.account';

/** The ledger of plaintexts this build could not map, in the account file. One key, a JSON array. */
export const SET_ASIDE_NAMESPACE = 'signal.setaside';

/**
 * The one key of that namespace — the ledger itself, oldest entry first. Exported so a test can
 * write a ledger exactly as a damaged one would stand in the file.
 */
export const LEDGER_KEY = 'entries';
/** And the count of plaintexts the limit pushed out of it. */
const DROPPED_KEY = 'dropped';

/**
 * How many plaintexts one account keeps. Signal deletes an envelope once this device acknowledged
 * it, so a plaintext curlew could not read is the only copy left anywhere: the ledger is bounded
 * so a decoder bug cannot fill the account file, and a run that pushes an entry out says so.
 */
export const SET_ASIDE_LIMIT = 200;

/** One decrypted plaintext this build could not map, kept verbatim. */
export interface SetAsideEntry {
  /** Who sent it: the ACI to look the plaintext up by on the phone. */
  senderAci: string;
  /** When they sent it — the envelope's client timestamp, ISO. */
  sentAt: string;
  /** Why nothing was mapped: a parse error, or fields a newer Signal added. */
  reason: string;
  /** The decrypted plaintext, base64 (padded, when unpadding itself failed). */
  plaintext: string;
}

/** The stored ledger, oldest first: what a listing can show, and everything it is kept in. */
interface ParsedLedger {
  /** The entries that name a sender and a time — the ones a listing can point at on the phone. */
  entries: SetAsideEntry[];
  /**
   * Every stored entry, readable or not, exactly as it stands. `setAside` appends by rewriting
   * the WHOLE ledger, so it must be handed this rather than `entries`: a filtered list would
   * delete the only copy of a plaintext the next time another one arrived.
   */
  stored: unknown[];
}

/**
 * The stored ledger, oldest first. A damaged one reads as empty, never as a throw.
 *
 * An entry is shown only when it names a sender and a time: without both there is no way to find
 * the message on the phone, so `readSetAside` counts it as lost instead of listing `undefined`
 * for it. What is not shown is still kept in `stored`.
 */
function parseLedger(stored: string | null): ParsedLedger {
  if (!stored) return { entries: [], stored: [] };
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return { entries: [], stored: [] };
    const rows = parsed as unknown[];
    const entries: SetAsideEntry[] = [];
    for (const raw of rows) {
      const entry = showable(raw);
      if (entry) entries.push(entry);
    }
    return { entries, stored: rows };
  } catch {
    return { entries: [], stored: [] };
  }
}

/** What a listing shows for an entry that never recorded why it was kept. */
const UNRECORDED_REASON = 'unrecorded';

/**
 * One stored entry as a listing shows it, or null when it lacks a sender or a time.
 *
 * A non-object entry reads as null instead of throwing, and a missing `reason` is a hole in the
 * record, not a reason to hide a message whose sender and time are still there: it shows this
 * fixed placeholder rather than `undefined`.
 */
function showable(raw: unknown): SetAsideEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as {
    senderAci?: unknown;
    sentAt?: unknown;
    reason?: unknown;
    plaintext?: unknown;
  };
  if (typeof entry.senderAci !== 'string' || entry.senderAci === '') return null;
  if (typeof entry.sentAt !== 'string' || entry.sentAt === '') return null;
  return {
    senderAci: entry.senderAci,
    sentAt: entry.sentAt,
    reason: typeof entry.reason === 'string' && entry.reason !== '' ? entry.reason : UNRECORDED_REASON,
    // Not a string reads as no plaintext at all: the message can still be found, its size is 0.
    plaintext: typeof entry.plaintext === 'string' ? entry.plaintext : '',
  };
}

/** The stored dropped count; anything unreadable is zero, not a failure. */
function parseDropped(stored: string | null): number {
  return Number(stored ?? 0) || 0;
}

/**
 * The ledger of one account as the delivery port reports it: who sent what this build could not
 * map, when, why, and how big the plaintext was — and never the plaintext itself, which stays in
 * the account file. An account that keeps none reads as an empty ledger, never as a throw. An
 * entry with no sender or no time is not listed — there is nothing on a phone to find it by — but
 * it is counted in `dropped`, so a message nobody can see here never goes unnoticed.
 *
 * Reads the file rather than a `SignalProtocolStore` on purpose: the ledger is curlew's own
 * JSON, and reading a diagnosis is exactly what someone needs on a machine where libsignal does
 * not load at all.
 */
export function readSetAside(file: SecretStore): SetAsideLedger {
  const namespace = file.load(SET_ASIDE_NAMESPACE);
  const dropped = parseDropped(namespace.get(DROPPED_KEY) ?? null);
  const ledger = parseLedger(namespace.get(LEDGER_KEY) ?? null);
  return {
    // Entries no listing can point at on the phone count as dropped along with the ones the bound
    // pushed out: for this answer both mean a message this command will never show.
    dropped: dropped + (ledger.stored.length - ledger.entries.length),
    entries: ledger.entries.map((entry) => ({
      sender: entry.senderAci,
      sentAt: entry.sentAt,
      reason: entry.reason,
      // Decoded rather than measured from the base64 length: the length lies wherever an entry
      // holds padding, and one damaged entry reports 0 bytes instead of failing the whole listing.
      bytes: plaintextSize(entry.plaintext),
    })),
  };
}

/** How many bytes a stored base64 plaintext holds, 0 when it does not decode. */
function plaintextSize(base64: string): number {
  try {
    return fromBase64(base64).byteLength;
  } catch {
    return 0;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The linked device's own credentials — what `linkDevice` created. */
export interface DeviceAccount {
  aci: string;
  deviceId: number;
  password: string;
  registrationId: number;
}

type Address = Core.ProtocolAddress;

const addressKey = (a: Address): string => `${a.name()}.${a.deviceId()}`;

export class SignalProtocolStore {
  private readonly lib: SignalLib;
  private readonly store: SecretStore;
  private readonly data = new Map<string, Map<string, string>>();
  private readonly dirty = new Map<string, Set<string>>();
  /** How many times the file was written — a test measures the batching with it. */
  writes = 0;
  /** Identity keys that changed since the last `takeIdentityChanges()` — a new safety number. */
  private identityChanges: Array<{ aci: string; at: string }> = [];

  private constructor(lib: SignalLib, store: SecretStore) {
    this.lib = lib;
    this.store = store;
  }

  /** Load the whole file (one execution). */
  static open(lib: SignalLib, store: SecretStore): SignalProtocolStore {
    const s = new SignalProtocolStore(lib, store);
    for (const [namespace, entries] of store.loadAll()) s.data.set(namespace, new Map(entries));
    return s;
  }

  // ── raw access ──

  get(namespace: string, key: string): string | null {
    return this.data.get(namespace)?.get(key) ?? null;
  }

  set(namespace: string, key: string, value: string | null): void {
    let map = this.data.get(namespace);
    if (!map) {
      map = new Map();
      this.data.set(namespace, map);
    }
    if (value === null) map.delete(key);
    else map.set(key, value);
    let keys = this.dirty.get(namespace);
    if (!keys) {
      keys = new Set();
      this.dirty.set(namespace, keys);
    }
    keys.add(key);
  }

  /** Every key of a namespace (ids of stored pre-keys, addresses of sessions). */
  keys(namespace: string): string[] {
    return [...(this.data.get(namespace)?.keys() ?? [])];
  }

  count(namespace: string): number {
    return this.data.get(namespace)?.size ?? 0;
  }

  get pending(): number {
    let n = 0;
    for (const keys of this.dirty.values()) n += keys.size;
    return n;
  }

  /** Write every change since the last flush in one transaction. */
  flush(): void {
    if (this.dirty.size === 0) return;
    const changes: SecretChange[] = [];
    for (const [namespace, keys] of this.dirty) {
      for (const key of keys) changes.push({ namespace, key, value: this.get(namespace, key) });
    }
    this.store.apply(changes);
    this.dirty.clear();
    this.writes++;
  }

  /** The contacts whose identity key changed since the last call, and when. */
  takeIdentityChanges(): Array<{ aci: string; at: string }> {
    const changes = this.identityChanges;
    this.identityChanges = [];
    return changes;
  }

  /** When a contact's safety number last changed, as recorded — null when it never did. */
  identityChangedAt(aci: string): string | null {
    return this.get(NS.identityChanged, aci);
  }

  // ── the ledger of plaintexts curlew could not map ──

  /**
   * Keep a plaintext this build could not map, base64 as given, oldest first.
   *
   * It joins the dirty set here, so the next `flush()` — the one the receiver makes BEFORE it
   * acknowledges the envelopes these came from — writes it with the ratchet state. Signal deletes
   * an acknowledged envelope: without this the plaintext would exist nowhere at all.
   */
  setAside(entry: SetAsideEntry): number {
    // The ledger as stored, not the entries a listing shows: this rewrites every plaintext the
    // account keeps, and one without a sender or a time is still the only copy of a message.
    const ledger = parseLedger(this.get(SET_ASIDE_NAMESPACE, LEDGER_KEY)).stored;
    ledger.push(entry);
    let dropped = 0;
    while (ledger.length > SET_ASIDE_LIMIT) {
      ledger.shift();
      dropped++;
    }
    if (dropped > 0) this.set(SET_ASIDE_NAMESPACE, DROPPED_KEY, String(this.setAsideDropped() + dropped));
    this.set(SET_ASIDE_NAMESPACE, LEDGER_KEY, JSON.stringify(ledger));
    return dropped;
  }

  /** The kept plaintexts a listing can show, oldest first. A damaged ledger reads as empty, never as a throw. */
  setAsideEntries(): SetAsideEntry[] {
    return parseLedger(this.get(SET_ASIDE_NAMESPACE, LEDGER_KEY)).entries;
  }

  /** How many plaintexts the limit pushed out of the ledger — data that really is gone. */
  setAsideDropped(): number {
    return parseDropped(this.get(SET_ASIDE_NAMESPACE, DROPPED_KEY));
  }

  /** Drop unwritten changes (a link that failed before the phone confirmed it). */
  discard(): void {
    this.dirty.clear();
  }

  // ── the device ──

  get registered(): boolean {
    return this.account() !== null;
  }

  account(): DeviceAccount | null {
    const aci = this.get(NS.account, 'aci');
    const deviceId = this.get(NS.account, 'deviceId');
    const password = this.get(NS.account, 'password');
    const registrationId = this.get(NS.account, 'registrationId');
    if (!aci || !deviceId || !password || !registrationId) return null;
    return { aci, deviceId: Number(deviceId), password, registrationId: Number(registrationId) };
  }

  setAccount(account: DeviceAccount): void {
    this.set(NS.account, 'aci', account.aci);
    this.set(NS.account, 'deviceId', String(account.deviceId));
    this.set(NS.account, 'password', account.password);
    this.set(NS.account, 'registrationId', String(account.registrationId));
  }

  setIdentityKey(privateKey: Core.PrivateKey): void {
    this.set(NS.account, 'identityPrivate', toBase64(privateKey.serialize()));
  }

  identityKey(): Core.PrivateKey {
    const stored = this.get(NS.account, 'identityPrivate');
    if (!stored) throw new Error('the Signal session has no identity key');
    return this.lib.core.PrivateKey.deserialize(fromBase64(stored));
  }

  /**
   * The phone number identity, kept beside the ACI one. Signal holds the PNI keys it was given at
   * link time; this key is what a client needs to sign for its own number later, so dropping it
   * would leave a session that cannot be re-linked.
   */
  setPniIdentityKey(privateKey: Core.PrivateKey): void {
    this.set(NS.account, 'pniIdentityPrivate', toBase64(privateKey.serialize()));
  }

  pniIdentityKey(): Core.PrivateKey | null {
    const stored = this.get(NS.account, 'pniIdentityPrivate');
    return stored === null ? null : this.lib.core.PrivateKey.deserialize(fromBase64(stored));
  }

  /**
   * This account's phone number identity, as a service id (`PNI:<uuid>`).
   *
   * The key above says WHICH number we can sign for; this says what the number is. The
   * provisioning message carries both (field 12 and field 18) and curlew kept only the key,
   * so nothing on disk could recognise our own number arriving in a message. That matters:
   * a self-note addressed to the PNI carries a bare uuid in the legacy string field, which
   * `isAci` cannot tell from a contact's, so the user's own number lands in the peer directory.
   */
  setPni(pni: string): void {
    this.set(NS.account, 'pni', pni);
  }

  pni(): string | null {
    return this.get(NS.account, 'pni');
  }

  setRegistrationId(id: number): void {
    this.set(NS.account, 'registrationId', String(id));
  }

  // ── libsignal's stores ──

  readonly sessions = {
    saveSession: async (address: Address, record: Core.SessionRecord): Promise<void> => {
      this.set(NS.session, addressKey(address), toBase64(record.serialize()));
    },
    getSession: async (address: Address): Promise<Core.SessionRecord | null> => {
      const stored = this.get(NS.session, addressKey(address));
      return stored ? this.lib.core.SessionRecord.deserialize(fromBase64(stored)) : null;
    },
    getExistingSessions: async (addresses: Address[]): Promise<Core.SessionRecord[]> =>
      addresses.map((address) => {
        const stored = this.get(NS.session, addressKey(address));
        if (!stored) throw new Error(`no session for ${addressKey(address)}`);
        return this.lib.core.SessionRecord.deserialize(fromBase64(stored));
      }),
  } as unknown as Core.SessionStore;

  readonly identities = {
    getIdentityKey: async (): Promise<Core.PrivateKey> => this.identityKey(),
    getIdentityKeyPair: async (): Promise<Core.IdentityKeyPair> => {
      const key = this.identityKey();
      return new this.lib.core.IdentityKeyPair(key.getPublicKey(), key);
    },
    getLocalRegistrationId: async (): Promise<number> => {
      const id = this.get(NS.account, 'registrationId');
      if (!id) throw new Error('the Signal session has no registration id');
      return Number(id);
    },
    // Read-only client: every identity is accepted. curlew never sends, so there is no message a
    // changed key could leak to the wrong person — but a change is not swallowed: `saveIdentity`
    // records it and the conversation shows a "safety number changed" notice.
    isTrustedIdentity: async (): Promise<boolean> => true,
    saveIdentity: async (address: Address, key: Core.PublicKey): Promise<Core.IdentityChange> => {
      const previous = this.get(NS.identity, address.name());
      const next = toBase64(key.serialize());
      this.set(NS.identity, address.name(), next);
      if (previous && previous !== next) {
        // Accepted (see `isTrustedIdentity`) but never silently: the change is recorded per
        // contact and reported to the receiver, which shows it in the conversation.
        const at = new Date().toISOString();
        this.set(NS.identityChanged, address.name(), at);
        this.identityChanges.push({ aci: address.name(), at });
        return this.lib.core.IdentityChange.ReplacedExisting;
      }
      return this.lib.core.IdentityChange.NewOrUnchanged;
    },
    getIdentity: async (address: Address): Promise<Core.PublicKey | null> => {
      const stored = this.get(NS.identity, address.name());
      return stored ? this.lib.core.PublicKey.deserialize(fromBase64(stored)) : null;
    },
  } as unknown as Core.IdentityKeyStore;

  readonly preKeys = {
    savePreKey: async (id: number, record: Core.PreKeyRecord): Promise<void> => {
      this.set(NS.preKey, String(id), toBase64(record.serialize()));
    },
    getPreKey: async (id: number): Promise<Core.PreKeyRecord> => {
      const stored = this.get(NS.preKey, String(id));
      if (!stored) throw new Error(`pre-key ${id} not found`);
      return this.lib.core.PreKeyRecord.deserialize(fromBase64(stored));
    },
    removePreKey: async (id: number): Promise<void> => {
      this.set(NS.preKey, String(id), null);
    },
  } as unknown as Core.PreKeyStore;

  readonly signedPreKeys = {
    saveSignedPreKey: async (id: number, record: Core.SignedPreKeyRecord): Promise<void> => {
      this.set(NS.signedPreKey, String(id), toBase64(record.serialize()));
    },
    getSignedPreKey: async (id: number): Promise<Core.SignedPreKeyRecord> => {
      const stored = this.get(NS.signedPreKey, String(id));
      if (!stored) throw new Error(`signed pre-key ${id} not found`);
      return this.lib.core.SignedPreKeyRecord.deserialize(fromBase64(stored));
    },
  } as unknown as Core.SignedPreKeyStore;

  /** Save a Kyber pre-key; a last-resort key is kept after use, a one-time key is not. */
  saveKyberPreKey(id: number, record: Core.KyberPreKeyRecord, lastResort: boolean): void {
    this.set(
      NS.kyberPreKey,
      String(id),
      JSON.stringify({ record: toBase64(record.serialize()), lastResort }),
    );
  }

  readonly kyberPreKeys = {
    saveKyberPreKey: async (id: number, record: Core.KyberPreKeyRecord): Promise<void> => {
      this.saveKyberPreKey(id, record, false);
    },
    getKyberPreKey: async (id: number): Promise<Core.KyberPreKeyRecord> => {
      const stored = this.get(NS.kyberPreKey, String(id));
      if (!stored) throw new Error(`kyber pre-key ${id} not found`);
      return this.lib.core.KyberPreKeyRecord.deserialize(
        fromBase64((JSON.parse(stored) as { record: string }).record),
      );
    },
    markKyberPreKeyUsed: async (
      id: number,
      signedPreKeyId: number,
      baseKey: Core.PublicKey,
    ): Promise<void> => {
      const stored = this.get(NS.kyberPreKey, String(id));
      if (!stored) throw new Error(`kyber pre-key ${id} not found`);
      if (!(JSON.parse(stored) as { lastResort: boolean }).lastResort) {
        this.set(NS.kyberPreKey, String(id), null);
        return;
      }
      // A last-resort key stays; the same (key, signed key, base key) twice is a replay.
      const seen = `${id}:${signedPreKeyId}:${toBase64(baseKey.serialize())}`;
      if (this.get(NS.kyberUsed, seen)) throw new Error('kyber pre-key reused with the same base key');
      this.set(NS.kyberUsed, seen, '1');
    },
  } as unknown as Core.KyberPreKeyStore;

  readonly senderKeys = {
    saveSenderKey: async (
      sender: Address,
      distributionId: string,
      record: Core.SenderKeyRecord,
    ): Promise<void> => {
      this.set(NS.senderKey, `${addressKey(sender)}::${distributionId}`, toBase64(record.serialize()));
    },
    getSenderKey: async (sender: Address, distributionId: string): Promise<Core.SenderKeyRecord | null> => {
      const stored = this.get(NS.senderKey, `${addressKey(sender)}::${distributionId}`);
      return stored ? this.lib.core.SenderKeyRecord.deserialize(fromBase64(stored)) : null;
    },
  } as unknown as Core.SenderKeyStore;
}
