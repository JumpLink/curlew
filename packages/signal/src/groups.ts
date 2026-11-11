/**
 * Signal group names (`docs/design/signal-groups.md`).
 *
 * A group message carries the group's master key and nothing else about the group: its name lives
 * on the group service, encrypted with a key derived from that master key. Two reads fetch it,
 * each behind its own gate (`guard.ts`): the day's group credentials on a chat connection of this
 * account, then `GET /v2/groups` on the storage host, authenticated by a presentation of that
 * credential for the one group.
 *
 * `GroupNames` is the network half: master key in, name out. `GroupTitles` is the session half:
 * it remembers which groups a batch of messages named, fetches the ones whose name is unknown or
 * out of date, caches the result in the account's session file and hands the receiver a `chat`
 * event per name found. A failed fetch never fails the sync: the group stays unnamed until the
 * retry window passes, and the failure is reported once per session.
 */

import type { DeliveryEvent } from '@curlew/protocol';
import { SIGNAL_ROOT_CA_PEM, SIGNAL_SERVER_PUBLIC_PARAMS_BASE64, SIGNAL_STORAGE_HOST } from './constants.ts';
import { type ChatFetch, GroupsViolation, storageRefusal } from './guard.ts';
import type { SignalLib } from './lib.ts';
import { basicAuth, USER_AGENT } from './net.ts';
import { bytesField, decodeFields, numberField, stringField } from './proto.ts';
import { type DeviceAccount, fromBase64, NS, type SignalProtocolStore } from './protocol-store.ts';

const DAY_SECONDS = 86_400;
const MAX_TITLE_CHARS = 256;

/** What the group service said about one group. */
export interface GroupName {
  /** The decrypted name; null for a group without one, or one this account may not read. */
  title: string | null;
  /** The group's revision (`Group.version`). */
  revision: number | null;
}

/** The storage host's answer. */
export interface StorageResponse {
  status: number;
  body: Uint8Array;
}

export interface StorageRequest {
  verb: 'GET';
  host: string;
  path: string;
  headers: ReadonlyArray<[string, string]>;
}

export type StorageFetch = (request: StorageRequest) => Promise<StorageResponse>;

/** Reads one group's name from a master key — the seam a test replaces. */
export type GroupNameSource = (masterKey: Uint8Array) => Promise<GroupName>;

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * `GET` over `node:https`, pinned to Signal's root: the storage host chains to the same private
 * CA as the CDN (`httpsDownloader` in `contacts.ts` documents why `ca` is load-bearing).
 */
export function httpsStorage(maxBytes = 1024 * 1024): StorageFetch {
  return async (request) => {
    const refusal = storageRefusal(request, SIGNAL_STORAGE_HOST);
    if (refusal) throw new GroupsViolation(refusal);
    const https = await import('node:https');
    return new Promise<StorageResponse>((resolve, reject) => {
      const headers = Object.fromEntries(request.headers);
      const req = https.get(
        { host: request.host, path: request.path, headers, ca: SIGNAL_ROOT_CA_PEM, timeout: 20_000 },
        (res) => {
          const chunks: Uint8Array[] = [];
          let size = 0;
          res.on('data', (chunk: Uint8Array) => {
            size += chunk.length;
            if (size > maxBytes) {
              req.destroy(new Error('the group service answered with more than allowed'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const body = new Uint8Array(size);
            let at = 0;
            for (const c of chunks) {
              body.set(c, at);
              at += c.length;
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('the group service did not answer in time')));
      req.on('error', reject);
    });
  };
}

export interface GroupNamesOptions {
  lib: SignalLib;
  account: DeviceAccount;
  /** A chat connection behind the groups gate; opened per credential fetch, closed straight after. */
  openChannel: () => Promise<{ fetch: ChatFetch; close(): Promise<void> }>;
  storage?: StorageFetch;
  /** Overridden by a test that plays the server; Signal's production parameters by default. */
  serverPublicParams?: Uint8Array;
  now?: () => number;
}

interface DayCredential {
  day: number;
  credential: ReturnType<InstanceType<SignalLib['zk']['ClientZkAuthOperations']>['receiveAuthCredentialWithPniAsServiceId']>;
}

export class GroupNames {
  private readonly options: GroupNamesOptions;
  private readonly ops: InstanceType<SignalLib['zk']['ClientZkAuthOperations']>;
  private cached: DayCredential | null = null;

  constructor(options: GroupNamesOptions) {
    this.options = options;
    const params = options.serverPublicParams ?? fromBase64(SIGNAL_SERVER_PUBLIC_PARAMS_BASE64);
    this.ops = new options.lib.zk.ClientZkAuthOperations(
      new options.lib.zk.ServerPublicParams(params as Uint8Array<ArrayBuffer>),
    );
  }

  private nowMs(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Today's credential — one chat request a day per process, however many groups are named. */
  private async credential(): Promise<DayCredential['credential']> {
    const day = Math.floor(this.nowMs() / 1000 / DAY_SECONDS) * DAY_SECONDS;
    if (this.cached?.day === day) return this.cached.credential;
    const { lib, account } = this.options;
    const channel = await this.options.openChannel();
    let response;
    try {
      response = await channel.fetch({
        verb: 'GET',
        path: `/v1/certificate/auth/group?redemptionStartSeconds=${day}&redemptionEndSeconds=${day + 7 * DAY_SECONDS}&v101=true&zkcCredential=true`,
        headers: [['Accept', 'application/json']],
      });
    } finally {
      await channel.close().catch(() => undefined);
    }
    if (response.status !== 200 || !response.body) {
      throw new Error(`the group credentials were refused (${response.status})`);
    }
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
      credentials?: Array<{ credential: string; redemptionTime: number }>;
      pni?: string;
    };
    const entry = parsed.credentials?.find((c) => c.redemptionTime === day);
    if (!entry || !parsed.pni) throw new Error('the server sent no group credential for today');
    const credential = this.ops.receiveAuthCredentialWithPniAsServiceId(
      lib.core.Aci.fromUuid(account.aci),
      lib.core.Pni.fromUuid(parsed.pni.replace(/^PNI:/i, '')),
      entry.redemptionTime,
      new lib.zk.AuthCredentialWithPniResponse(fromBase64(entry.credential) as Uint8Array<ArrayBuffer>),
    );
    this.cached = { day, credential };
    return credential;
  }

  /** The name of the group `masterKey` belongs to. */
  readonly nameOf: GroupNameSource = async (masterKey) => {
    const { lib } = this.options;
    const credential = await this.credential();
    const secret = lib.zk.GroupSecretParams.deriveFromMasterKey(
      new lib.zk.GroupMasterKey(masterKey as Uint8Array<ArrayBuffer>),
    );
    const presentation = this.ops.createAuthCredentialWithPniPresentation(secret, credential);
    const response = await (this.options.storage ?? httpsStorage())({
      verb: 'GET',
      host: SIGNAL_STORAGE_HOST,
      path: '/v2/groups',
      headers: [
        basicAuth(hex(secret.getPublicParams().serialize()), hex(presentation.serialize())),
        ['Content-Type', 'application/x-protobuf'],
        ['User-Agent', USER_AGENT],
      ],
    });
    // 403: the account is not (or no longer) a member, so there is no name it may read.
    if (response.status === 403) return { title: null, revision: null };
    if (response.status === 401) {
      this.cached = null;
      throw new Error('the group service refused the credential');
    }
    if (response.status !== 200) throw new Error(`the group service answered ${response.status}`);
    const group = groupOf(response.body);
    const sealed = bytesField(group, 2);
    const revision = numberField(group, 6);
    if (!sealed || sealed.length === 0) return { title: null, revision };
    const blob = decodeFields(new lib.zk.ClientZkGroupCipher(secret).decryptBlob(sealed as Uint8Array<ArrayBuffer>));
    const title = stringField(blob, 1)?.trim().slice(0, MAX_TITLE_CHARS) || null;
    return { title, revision };
  };
}

/** `GroupResponse` wraps the `Group` in field 1; a bare `Group` carries its public key there. */
function groupOf(body: Uint8Array): ReturnType<typeof decodeFields> {
  const outer = decodeFields(body);
  const inner = bytesField(outer, 1);
  if (inner) {
    try {
      const fields = decodeFields(inner);
      if (fields.has(2) || fields.has(6)) return fields;
    } catch {
      // A public key is not a message: this is a bare `Group`.
    }
  }
  return outer;
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the group service did not answer in time')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ── the session half ────────────────────────────────────────────────────

/** What the session file keeps per group: no key, only what saves the next fetch. */
interface CachedGroup {
  /** The revision the cached name belongs to. */
  r: number | null;
  /** The name; null while it is unknown. */
  t: string | null;
  /** When the group service was last asked, ms since epoch. */
  at: number;
}

export interface GroupTitlesOptions {
  /** Groups named per call; the rest wait for the next batch. */
  perBatch?: number;
  /** How long a failed or empty answer is believed before the group is asked again. */
  retryAfterMs?: number;
  /** The longest one lookup may take, connect included. */
  deadlineMs?: number;
  now?: () => number;
}

export class GroupTitles {
  private readonly store: SignalProtocolStore;
  private readonly source: GroupNameSource;
  private readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  private readonly perBatch: number;
  private readonly retryAfterMs: number;
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private readonly pending = new Map<string, { key: Uint8Array; revision: number | null }>();
  private firstProblem: string | null = null;

  /**
   * @param exclusive Runs a write with the protocol store to itself (`SignalReceiver.exclusive`):
   *   a name is written between commits, never in the middle of one.
   */
  constructor(
    store: SignalProtocolStore,
    source: GroupNameSource,
    exclusive: <T>(work: () => Promise<T>) => Promise<T>,
    options: GroupTitlesOptions = {},
  ) {
    this.store = store;
    this.source = source;
    this.exclusive = exclusive;
    this.perBatch = options.perBatch ?? 8;
    this.retryAfterMs = options.retryAfterMs ?? 6 * 3_600_000;
    this.now = options.now ?? Date.now;
    this.deadlineMs = options.deadlineMs ?? 30_000;
  }

  /** A message named this group. Cheap: nothing leaves the process until `resolve`. */
  seen(chatId: string, masterKey: Uint8Array, revision: number | null): void {
    const known = this.pending.get(chatId);
    const newest = Math.max(known?.revision ?? -1, revision ?? -1);
    this.pending.set(chatId, { key: masterKey, revision: newest < 0 ? null : newest });
  }

  /** The first fetch that failed this session, as a sentence; null when none did. */
  get problem(): string | null {
    return this.firstProblem;
  }

  private cache(chatId: string): CachedGroup | null {
    const raw = this.store.get(NS.groups, chatId);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CachedGroup;
    } catch {
      return null;
    }
  }

  private due(cached: CachedGroup | null, revision: number | null): boolean {
    if (!cached) return true;
    const newer = revision !== null && (cached.r === null || revision > cached.r);
    if (cached.t) return newer;
    return newer || this.now() - cached.at >= this.retryAfterMs;
  }

  /** Fetch the names that are due and return them as events for the batch that is being handed on. */
  async resolve(): Promise<DeliveryEvent[]> {
    const events: DeliveryEvent[] = [];
    const todo = [...this.pending].slice(0, this.perBatch);
    for (const [chatId] of todo) this.pending.delete(chatId);
    for (const [chatId, { key, revision }] of todo) {
      const cached = this.cache(chatId);
      if (!this.due(cached, revision)) continue;
      let name: GroupName;
      try {
        name = await withDeadline(this.source(key), this.deadlineMs);
      } catch (err) {
        this.firstProblem ??= `a Signal group's name could not be fetched (${err instanceof Error ? err.message : String(err)})`;
        await this.write(chatId, { r: cached?.r ?? null, t: cached?.t ?? null, at: this.now() });
        continue;
      }
      await this.write(chatId, { r: name.revision ?? revision, t: name.title, at: this.now() });
      if (name.title) {
        events.push({
          type: 'chat',
          chat: { remoteId: chatId, kind: 'group', title: name.title, members: null },
        });
      }
    }
    return events;
  }

  private write(chatId: string, entry: CachedGroup): Promise<void> {
    return this.exclusive(async () => {
      this.store.set(NS.groups, chatId, JSON.stringify(entry));
      this.store.flush();
    });
  }
}
