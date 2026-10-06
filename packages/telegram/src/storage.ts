/**
 * mtcute's storage on postbote's own SQLite: the session file of one Telegram account.
 *
 * mtcute ships an IndexedDB storage for the web and better-sqlite3 ones for Node/Bun/Deno.
 * Neither fits: GJS has no IndexedDB, and mtcute's SQLite repositories bind BLOBs, which the
 * libgda-backed `node:sqlite` cannot carry (parameters are interpolated, not bound — see
 * packages/store/AGENTS.md). So this is mtcute's in-memory storage, loaded from a `SecretStore`
 * on open and written back as a diff on save:
 *
 *   - `authKeys` — the session's auth keys. mtcute requires these to be written IMMEDIATELY, so
 *     every change to them is flushed at once (a handful of times per account lifetime).
 *   - `kv` — the session's small state: the DC, the self user, the update state.
 *   - `peers` — access hashes, without which no chat can be addressed after a restart.
 *   - `refMessages` — where a "min" peer was seen, to resolve it later.
 *
 * Everything is TEXT: bytes as base64, peers as JSON. A save diffs against what was loaded and
 * writes only the changed keys, in multi-row statements — a wide parse per few keys rather than
 * a statement each (see `insertMany` in `@curlew/store`).
 *
 * The file is SECRET: whoever holds it can read the account. It never enters a log, a DTO or
 * MCP output; `SecretStore` keeps it 0600 in a 0700 directory outside the repository.
 */

import type { IStorageDriver, ITelegramStorageProvider } from '@mtcute/core';
import {
  MemoryAuthKeysRepository,
  MemoryKeyValueRepository,
  MemoryPeersRepository,
  MemoryRefMessagesRepository,
  MemoryStorageDriver,
} from '@mtcute/core';
import type { SecretChange, SecretStore } from '@curlew/store';
import { Buffer } from 'node:buffer';

type Snapshot = Map<string, Map<string, string>>;

const NS = {
  authKeys: 'mtcute.auth_keys',
  authKeysTemp: 'mtcute.auth_keys_temp',
  kv: 'mtcute.kv',
  peers: 'mtcute.peers',
  refMessages: 'mtcute.ref_messages',
} as const;

/** postbote's own namespace in the same file: which account this is, for `accounts list`. */
export const ACCOUNT_NAMESPACE = 'postbote.account';

/**
 * True when the file already holds a SIGNED-IN session — Telegram authorized it AND the sign-in
 * itself completed, so the file is the only copy of a working account.
 *
 * The marker is mtcute's `notifyLoggedIn` → `CurrentUserService.store`, which writes the
 * `current_user` kv key (non-empty bytes; logged out = empty bytes) and calls `driver.save()` at
 * once. It is NOT the auth key: mtcute creates that in the MTProto DH handshake on CONNECT
 * (`SessionConnection.onConnected` → `_authorize` → `onKeyChange` → `authKeys.set`), before any
 * phone number is asked for — so every failed login has an auth key, and treating one as proof of a
 * sign-in kept a session that was never authorized and told the user it had been.
 *
 * This is a FACT about the file, and it is what `loginTelegram` decides on, because everything
 * AFTER the sign-in — the update manager, postbote's record writes, the final rename — can still
 * throw. A flag around the login promise would throw away a session that really is signed in.
 *
 * Fails SAFE: a file that cannot be read (already closed, unreadable) counts as signed in,
 * because the caller's alternative is deleting a session.
 */
export function holdsSignIn(store: SecretStore): boolean {
  try {
    // The stored values are base64, so a logged-out (empty byte) user is the empty string.
    return (store.load(NS.kv).get('current_user') ?? '') !== '';
  } catch {
    return true;
  }
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const unb64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));

/** A stored row, or `null` when it is not decodable — the caller skips it rather than failing. */
function decode<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

interface PeerRecord {
  accessHash: string;
  isMin: boolean;
  usernames: string[];
  updated: number;
  phone?: string;
  complete: string;
}

/** The driver: the in-memory state mtcute's repositories work on, plus load and save. */
class SecretStoreDriver extends MemoryStorageDriver implements IStorageDriver {
  private readonly store: SecretStore;
  private persisted: Snapshot = new Map();
  private loaded = false;

  constructor(store: SecretStore) {
    super();
    this.store = store;
  }

  private authState() {
    return this.getState('authKeys', () => ({
      authKeys: new Map<number, Uint8Array>(),
      authKeysTemp: new Map<string, Uint8Array>(),
      authKeysTempExpiry: new Map<string, number>(),
    }));
  }

  /** Serialize the current state into the same shape the store holds. */
  private snapshot(): Snapshot {
    const auth = this.authState();
    const kv = this.getState('kv', () => new Map<string, Uint8Array>());
    const peers = this.getState('peers', () => ({
      entities: new Map<number, { id: number } & Omit<PeerRecord, 'complete'> & { complete: Uint8Array }>(),
      usernameIndex: new Map<string, number>(),
      phoneIndex: new Map<string, number>(),
    }));
    const refs = this.getState('refMessages', () => ({ refs: new Map<number, Set<string>>() }));

    const snap: Snapshot = new Map();
    snap.set(NS.authKeys, new Map([...auth.authKeys].map(([dc, key]) => [String(dc), b64(key)])));
    snap.set(
      NS.authKeysTemp,
      new Map(
        [...auth.authKeysTemp].map(([k, key]) => [k, `${auth.authKeysTempExpiry.get(k) ?? 0}:${b64(key)}`]),
      ),
    );
    snap.set(NS.kv, new Map([...kv].map(([k, v]) => [k, b64(v)])));
    snap.set(
      NS.peers,
      new Map(
        [...peers.entities].map(([id, p]) => {
          const record: PeerRecord = {
            accessHash: p.accessHash,
            isMin: p.isMin,
            usernames: p.usernames,
            updated: p.updated,
            ...(p.phone ? { phone: p.phone } : {}),
            complete: b64(p.complete),
          };
          return [String(id), JSON.stringify(record)];
        }),
      ),
    );
    snap.set(
      NS.refMessages,
      new Map(
        [...refs.refs]
          .filter(([, set]) => set.size > 0)
          .map(([peer, set]) => [String(peer), JSON.stringify([...set])]),
      ),
    );
    return snap;
  }

  load(): void {
    if (this.loaded) return;
    const all = this.store.loadAll();
    const ns = (name: string) => all.get(name) ?? new Map<string, string>();

    // Populate the SAME state objects the repositories captured at construction.
    const auth = this.authState();
    for (const [dc, key] of ns(NS.authKeys)) auth.authKeys.set(Number(dc), unb64(key));
    for (const [k, value] of ns(NS.authKeysTemp)) {
      // `<expiry>:<base64>`. A row without the colon cannot be a temp key this code wrote, and
      // decoding it anyway would yield a key that is silently wrong and already expired — read as
      // "expired", so Telegram just re-authorizes instead of failing loudly on a corrupt file.
      const colon = value.indexOf(':');
      if (colon < 1) continue;
      const expires = Number(value.slice(0, colon));
      if (!Number.isFinite(expires)) continue;
      auth.authKeysTemp.set(k, unb64(value.slice(colon + 1)));
      auth.authKeysTempExpiry.set(k, expires);
    }
    const kv = this.getState('kv', () => new Map<string, Uint8Array>());
    for (const [k, v] of ns(NS.kv)) kv.set(k, unb64(v));

    const peers = this.getState('peers', () => ({
      entities: new Map<number, unknown>(),
      usernameIndex: new Map<string, number>(),
      phoneIndex: new Map<string, number>(),
    }));
    for (const [id, json] of ns(NS.peers)) {
      // A row that cannot be decoded is SKIPPED, not thrown on — the same reasoning as the temp
      // auth key above, for the same reason. mtcute loads the session again after a failed
      // connect, and this driver is the only thing standing between one damaged row and an
      // account the user cannot open at all. A skipped peer is an ordinary loss: its access hash
      // is gone, so that chat cannot be addressed until Telegram sends it again; the auth key,
      // the identity and every other chat are untouched. Failing the whole load instead would
      // throw the user out of a working session to protect one chat.
      const r = decode<PeerRecord>(json);
      if (r === null) continue;
      const peerId = Number(id);
      peers.entities.set(peerId, { id: peerId, ...r, complete: unb64(r.complete) });
      for (const username of r.usernames) peers.usernameIndex.set(username, peerId);
      if (r.phone) peers.phoneIndex.set(r.phone, peerId);
    }
    const refs = this.getState('refMessages', () => ({ refs: new Map<number, Set<string>>() }));
    for (const [peer, json] of ns(NS.refMessages)) {
      const ids = decode<string[]>(json);
      if (ids === null) continue;
      refs.refs.set(Number(peer), new Set(ids));
    }

    this.persisted = this.snapshot();
    // LAST, and only on the way out: mtcute's `asyncResettable` does not mark a rejected load as
    // finished and resets `_prepare` on every `disconnect()`, so a failed load is followed by a
    // real retry. Consuming the flag before the work would turn that retry into a silent no-op —
    // empty repositories read as "first run", a fresh auth key negotiated, and the stored one
    // overwritten by the next save. A working session replaced by a new one, with no error.
    this.loaded = true;
  }

  /** Write every key that differs from what the file holds. `only` limits it to some namespaces. */
  save(only?: readonly string[]): void {
    const current = this.snapshot();
    const changes: SecretChange[] = [];
    for (const [namespace, now] of current) {
      if (only && !only.includes(namespace)) continue;
      const before = this.persisted.get(namespace) ?? new Map<string, string>();
      for (const [key, value] of now) if (before.get(key) !== value) changes.push({ namespace, key, value });
      for (const key of before.keys()) if (!now.has(key)) changes.push({ namespace, key, value: null });
      this.persisted.set(namespace, now);
    }
    this.store.apply(changes);
  }

  saveAuthKeys(): void {
    this.save([NS.authKeys, NS.authKeysTemp]);
  }

  destroy(): void {
    this.save();
  }
}

/** Auth keys: mtcute requires every write here to be applied immediately, not batched. */
class ImmediateAuthKeysRepository extends MemoryAuthKeysRepository {
  private readonly flush: () => void;

  constructor(driver: MemoryStorageDriver, flush: () => void) {
    super(driver);
    this.flush = flush;
  }

  override set(dc: number, key: Uint8Array | null): void {
    super.set(dc, key);
    this.flush();
  }

  override setTemp(dc: number, idx: number, key: Uint8Array | null, expires: number): void {
    super.setTemp(dc, idx, key, expires);
    this.flush();
  }

  override deleteByDc(dc: number): void {
    super.deleteByDc(dc);
    this.flush();
  }

  override deleteAll(): void {
    super.deleteAll();
    this.flush();
  }
}

/** The storage provider handed to mtcute for one account. */
export class SecretStoreStorage implements ITelegramStorageProvider {
  readonly driver: SecretStoreDriver;
  readonly kv: MemoryKeyValueRepository;
  readonly authKeys: ImmediateAuthKeysRepository;
  readonly peers: MemoryPeersRepository;
  readonly refMessages: MemoryRefMessagesRepository;

  constructor(store: SecretStore) {
    const driver = new SecretStoreDriver(store);
    this.driver = driver;
    this.kv = new MemoryKeyValueRepository(driver);
    this.authKeys = new ImmediateAuthKeysRepository(driver, () => driver.saveAuthKeys());
    this.peers = new MemoryPeersRepository(driver);
    this.refMessages = new MemoryRefMessagesRepository(driver);
  }
}
