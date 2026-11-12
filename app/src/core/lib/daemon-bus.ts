/**
 * The session-bus interface `curlew daemon` exports, and the JSON that travels over it (ADR 0004,
 * amendment 2026-10-30, daemon send).
 *
 * Why a bus name and not a socket: owning `eu.jumplink.curlew.Daemon` IS the liveness check. A
 * caller does not stat a file, guess whether the process behind it still lives, or clean up a
 * stale one — it calls, and `NameHasNoOwner` means no daemon is running, which is exactly the
 * branch that falls back to the direct send path. The session bus is also per-user by
 * construction: another user's bus is another bus, and no permission bit has to be got right.
 *
 * Why ONE method taking and returning a JSON string, rather than a typed signature: the request
 * is the parameters of `curlew send` and the reply is a discriminated union with a nested list of
 * sent messages. As a D-Bus signature that is a `a{sv}` in and a deep struct out, written twice —
 * once as a type and once as a `GLib.Variant` builder — and every field added later changes both.
 * As `s` the signature never changes, the types below are the single description of the wire, and
 * `v` makes a version mismatch something the newer side can recognise instead of mis-parse.
 *
 * D-Bus errors stay reserved for the transport and for a defect: a send that was REFUSED (no
 * grant, not a sendable address) or that FAILED (the network said no) is a normal answer with a
 * sentence in it, because the caller has to tell those apart from "there is no daemon".
 */

import { basename } from 'node:path';
import { _, fmt, safeFileName } from '@curlew/protocol';
import type { AccessAsk, AccessReply } from '../access.ts';

export const DAEMON_BUS_NAME = 'eu.jumplink.curlew.Daemon';
export const DAEMON_OBJECT_PATH = '/eu/jumplink/curlew/Daemon';
export const DAEMON_INTERFACE = 'eu.jumplink.curlew.Daemon1';

export const DAEMON_INTERFACE_XML = `<node>
  <interface name="${DAEMON_INTERFACE}">
    <method name="Send">
      <arg type="s" name="request_json" direction="in"/>
      <arg type="ah" name="files" direction="in"/>
      <arg type="s" name="reply_json" direction="out"/>
    </method>
    <method name="FetchAttachment">
      <arg type="s" name="request_json" direction="in"/>
      <arg type="s" name="reply_json" direction="out"/>
    </method>
    <method name="FetchAvatars">
      <arg type="s" name="request_json" direction="in"/>
      <arg type="s" name="reply_json" direction="out"/>
    </method>
    <method name="RequestAccess">
      <arg type="s" name="request_json" direction="in"/>
      <arg type="s" name="reply_json" direction="out"/>
    </method>
    <method name="GetAccounts">
      <arg type="s" name="accounts_json" direction="out"/>
    </method>
    <signal name="Changed">
      <arg type="t" name="seq"/>
    </signal>
    <signal name="AccountsChanged"/>
  </interface>
</node>`;

/**
 * How long a caller waits for an attachment fetch.
 *
 * Large on purpose: behind this call is a real download from a CDN or a homeserver.
 */
export const DAEMON_FETCH_TIMEOUT_MS = 120_000;

/**
 * How long a caller waits for the daemon's answer.
 *
 * Generous on purpose: behind this call is a real send, and a WhatsApp send alone waits up to 15 s
 * for the server's acknowledgement while a Signal send may first have to fetch pre-keys for every
 * device of the recipient. A timeout here does NOT mean nothing was sent — the caller says so.
 */
export const DAEMON_SEND_TIMEOUT_MS = 120_000;

/** The wire version. Bump it when a field stops being optional or changes meaning. */
export const DAEMON_WIRE_VERSION = 7;

/**
 * What the daemon accepts as attachments of one send. The largest per-file limit of any sender
 * (WhatsApp) and the files-per-message limit they all share: the senders still apply their own,
 * stricter ones to the copy; this one only stops a caller from filling the disk through the bus.
 */
export const DAEMON_MAX_FILE_BYTES = 64_000_000;
export const DAEMON_MAX_FILES = 10;

/**
 * One send, as the calling process asks for it.
 *
 * `capability` and `account` are what the CALLER checked its grants for; the daemon re-checks the
 * same pair against its own freshly loaded config and refuses if it does not hold (fail closed).
 * `backend` lets the daemon find the session without resolving the account again — and a request
 * whose backend does not match the session it found is not followed, not guessed at.
 */
export interface DaemonSendRequest {
  v: number;
  backend: string;
  account: string;
  capability: string;
  to: string;
  text?: string;
  imageUrl?: string;
  subject?: string;
  /**
   * Absolute paths. In the process that asks they are the caller's files; the daemon sees them as
   * its own private copies of the files the caller handed over as descriptors (wire v7).
   */
  attachments?: string[];
  /** Chat: the message this one answers. Added in v4, so an older daemon is refused rather than dropping the link. */
  replyTo?: { remoteId: string; clientId?: string; fromSelf?: boolean; text?: string };
  /** Chat: react to this message instead of sending text. Added in v5, so an older daemon is refused. */
  reaction?: {
    target: { remoteId: string; clientId?: string; fromSelf?: boolean; text?: string };
    emoji: string | null;
    previous?: string;
  };
  /** Chat: edit one of the person's own messages instead of sending text. Added in v6. */
  edit?: {
    target: { remoteId: string; clientId?: string; fromSelf?: boolean; text?: string };
    text: string;
  };
  /** Chat: delete one of the person's own messages instead of sending text. Added in v6. */
  delete?: {
    target: { remoteId: string; clientId?: string; fromSelf?: boolean; text?: string };
  };
  format?: 'plain' | 'markdown';
}

/**
 * One attachment on the wire: the base name the caller wants it sent under and the index of its
 * descriptor in the call's fd list. A path never crosses the bus — the daemon would have to trust
 * it, and a sandboxed daemon could not open it (ADR 0011).
 */
export interface DaemonWireFile {
  name: string;
  handle: number;
}

/** `DaemonSendRequest` as it travels: the same, with descriptors in place of paths. */
export type DaemonSendWire = Omit<DaemonSendRequest, 'attachments'> & { attachments?: DaemonWireFile[] };

/** One message the daemon got out, and the body it was sent with — what the caller logs and indexes. */
export interface DaemonSendStep {
  sent: {
    target: string;
    id: string;
    sentAt: string;
    chatRemoteId?: string;
    encrypted?: boolean;
    warning?: string;
    attachments?: Array<{ filename: string; size: number }>;
  };
  body: string;
}

/**
 * What the daemon answers.
 *
 *   - `sent` — it went out on the daemon's connection. The daemon wrote NO log line and indexed
 *     nothing: the caller owns both, so a message is logged and indexed exactly once no matter
 *     which path carried it.
 *   - `not-followed` — the daemon is running but is not holding this account, so the caller's own
 *     direct path is free to take it.
 *   - `refused` — nothing was sent, and the reason is the user's to act on (no grant, an address
 *     the grant does not name).
 *   - `failed` — the send was attempted and did not complete. `message` is one sentence; whether
 *     anything reached the network is what it has to say.
 */
export type DaemonSendReply =
  | { v: number; kind: 'sent'; markdown: boolean; steps: DaemonSendStep[] }
  | { v: number; kind: 'not-followed' }
  | { v: number; kind: 'refused'; message: string }
  | { v: number; kind: 'failed'; message: string };

/** Where an account the daemon looks after stands (ADR 0007 §3). */
export type DaemonAccountState =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'logged-out'
  | 'held-elsewhere'
  | 'stopped';

/** One account. Ids, a state and timings — no content ever rides the bus (ADR 0007). */
export interface DaemonAccountEntry {
  backend: string;
  accountId: string;
  state: DaemonAccountState;
  /** ISO time the account entered this state. */
  since: string;
  /** Only while `reconnecting`: the wait before the next attempt. */
  retryInMs?: number;
}

/** What `GetAccounts` answers. */
export interface DaemonAccountsReply {
  v: number;
  accounts: DaemonAccountEntry[];
}

/** Read a `GetAccounts` reply off the wire, or throw. */
export function parseDaemonAccountsReply(json: string): DaemonAccountsReply {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error('the curlew daemon answered something that is not JSON', { cause: error });
  }
  const reply = value as Partial<DaemonAccountsReply> | null;
  if (typeof reply !== 'object' || reply === null || reply.v !== DAEMON_WIRE_VERSION) {
    throw new Error('the curlew daemon answered an account list this curlew does not speak');
  }
  if (!Array.isArray(reply.accounts)) throw new Error('the curlew daemon answered no account list');
  return reply as DaemonAccountsReply;
}

/**
 * Read a reply off the wire, or throw. Anything that is not one of the four kinds is a defect on
 * the other side, not a user path, so the message is terse and in English — except the version
 * mismatch, which is what an upgrade with the old daemon still running looks like.
 */
export function parseDaemonSendReply(json: string): DaemonSendReply {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error('the curlew daemon answered something that is not JSON', { cause: error });
  }
  if (typeof value !== 'object' || value === null) throw new Error('the curlew daemon answered no object');
  const reply = value as Partial<DaemonSendReply>;
  if (reply.v !== DAEMON_WIRE_VERSION) {
    throw new Error(
      fmt(
        _(
          'the running curlew daemon speaks send protocol {theirs} and this curlew speaks {ours} — nothing was sent; restart it with `systemctl --user restart curlew-daemon`',
        ),
        { theirs: String(reply.v), ours: String(DAEMON_WIRE_VERSION) },
      ),
    );
  }
  switch (reply.kind) {
    case 'sent':
      if (!Array.isArray((reply as { steps?: unknown }).steps))
        throw new Error('the curlew daemon reported a send without the messages it sent');
      return reply as DaemonSendReply;
    case 'not-followed':
      return reply as DaemonSendReply;
    case 'refused':
    case 'failed':
      if (typeof (reply as { message?: unknown }).message !== 'string')
        throw new Error('the curlew daemon reported a problem without saying what it was');
      return reply as DaemonSendReply;
    default:
      throw new Error(`the curlew daemon answered an unknown reply kind ${String(reply.kind)}`);
  }
}

/** Read a request off the wire, or throw — the daemon's side of the same check. */
export function parseDaemonSendWire(json: string): DaemonSendWire {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error('the send request is not JSON', { cause: error });
  }
  if (typeof value !== 'object' || value === null) throw new Error('the send request is not an object');
  const request = value as Partial<DaemonSendWire>;
  if (request.v !== DAEMON_WIRE_VERSION) {
    throw new Error(
      fmt(
        _(
          'the caller speaks send protocol {theirs} and this curlew daemon speaks {ours} — nothing was sent; restart it with `systemctl --user restart curlew-daemon`',
        ),
        { theirs: String(request.v), ours: String(DAEMON_WIRE_VERSION) },
      ),
    );
  }
  for (const field of ['backend', 'account', 'capability', 'to'] as const) {
    if (typeof request[field] !== 'string' || request[field] === '')
      throw new Error(`the send request has no ${field}`);
  }
  const files = request.attachments;
  if (
    files !== undefined &&
    (!Array.isArray(files) ||
      files.some(
        (file) =>
          typeof file !== 'object' ||
          file === null ||
          typeof file.name !== 'string' ||
          !Number.isInteger(file.handle),
      ))
  ) {
    throw new Error('the send request has attachments that are not a list of named descriptors');
  }
  checkMessageTarget('replyTo', request.replyTo);
  const reaction = request.reaction as { target?: unknown; emoji?: unknown; previous?: unknown } | undefined;
  if (reaction !== undefined) {
    if (typeof reaction !== 'object' || reaction === null) throw new Error('the send request has a malformed reaction');
    checkMessageTarget('reaction target', reaction.target ?? null);
    if (reaction.emoji !== null && (typeof reaction.emoji !== 'string' || reaction.emoji === '')) {
      throw new Error('the send request has a reaction whose emoji is neither text nor null');
    }
    if (reaction.previous !== undefined && (typeof reaction.previous !== 'string' || reaction.previous === '')) {
      throw new Error('the send request has a reaction whose previous emoji is not text');
    }
    if (request.text !== undefined || request.imageUrl !== undefined || request.attachments !== undefined || request.replyTo !== undefined) {
      throw new Error('the send request mixes a reaction with a message');
    }
  }
  const edit = request.edit as { target?: unknown; text?: unknown } | undefined;
  if (edit !== undefined) {
    if (typeof edit !== 'object' || edit === null) throw new Error('the send request has a malformed edit');
    checkMessageTarget('edit target', edit.target ?? null);
    if (typeof edit.text !== 'string' || edit.text === '') {
      throw new Error('the send request has an edit without text');
    }
    if (
      request.text !== undefined ||
      request.imageUrl !== undefined ||
      request.attachments !== undefined ||
      request.replyTo !== undefined ||
      request.reaction !== undefined ||
      request.delete !== undefined
    ) {
      throw new Error('the send request mixes an edit with another send');
    }
  }
  const deletion = request.delete as { target?: unknown } | undefined;
  if (deletion !== undefined) {
    if (typeof deletion !== 'object' || deletion === null) throw new Error('the send request has a malformed deletion');
    checkMessageTarget('deletion target', deletion.target ?? null);
    if (
      request.text !== undefined ||
      request.imageUrl !== undefined ||
      request.attachments !== undefined ||
      request.replyTo !== undefined ||
      request.reaction !== undefined ||
      request.edit !== undefined
    ) {
      throw new Error('the send request mixes a deletion with another send');
    }
  }
  return request as DaemonSendWire;
}

/** The wire form of a request whose attachments are `paths`, handles numbered in order. */
export function toDaemonWire(request: DaemonSendRequest): DaemonSendWire {
  const { attachments, ...rest } = request;
  if (attachments === undefined) return rest;
  return { ...rest, attachments: attachments.map((path, handle) => ({ name: basename(path), handle })) };
}

/** Where one received descriptor is to be copied to, relative to the call's private directory. */
export interface DaemonFdPlan {
  handle: number;
  /** `<index>/<safe name>`: one directory per file, so two files of one name never collide. */
  relativePath: string;
}

/**
 * Check the descriptors a send brought against the files it names, and decide where each lands.
 *
 * Every descriptor is used exactly once: a spare one is a caller that thinks it handed over
 * something the daemon would never read, and a repeated handle would send one file twice. The name
 * is reduced to one path segment here, on the receiving side of the trust boundary, whatever the
 * caller says.
 */
export function planFdFiles(files: readonly DaemonWireFile[], fdCount: number): DaemonFdPlan[] {
  if (files.length > DAEMON_MAX_FILES) {
    throw new Error(`the send request has ${files.length} attachments; at most ${DAEMON_MAX_FILES} are accepted`);
  }
  if (fdCount !== files.length) {
    throw new Error(`the send request names ${files.length} attachments and carries ${fdCount} descriptors`);
  }
  const seen = new Set<number>();
  return files.map((file, index) => {
    if (file.handle < 0 || file.handle >= fdCount) {
      throw new Error(`the send request has an attachment whose descriptor ${file.handle} is not in the call`);
    }
    if (seen.has(file.handle)) throw new Error(`the send request uses descriptor ${file.handle} twice`);
    seen.add(file.handle);
    return { handle: file.handle, relativePath: `${index}/${safeFileName(file.name)}` };
  });
}

/** The message a reply or a reaction points at: an id, and a few optional hints of the right type. */
function checkMessageTarget(what: string, value: unknown): void {
  if (value === undefined) return;
  const target = value as { remoteId?: unknown; clientId?: unknown; fromSelf?: unknown; text?: unknown } | null;
  if (typeof target !== 'object' || target === null || typeof target.remoteId !== 'string' || target.remoteId === '') {
    throw new Error(`the send request has a ${what} without a remoteId`);
  }
  if (
    (target.clientId !== undefined && typeof target.clientId !== 'string') ||
    (target.fromSelf !== undefined && typeof target.fromSelf !== 'boolean') ||
    (target.text !== undefined && typeof target.text !== 'string')
  ) {
    throw new Error(`the send request has a ${what} with a malformed clientId, fromSelf or text`);
  }
}

/** One attachment fetch, as the calling process asks for it. */
export interface DaemonFetchAttachmentRequest {
  v: number;
  backend: string;
  account: string;
  /** The network's opaque message id. */
  remoteId: string;
  /** Position of the attachment inside the message. */
  index: number;
  /** Max bytes before the fetch is aborted. */
  maxBytes: number;
}

/** What the daemon answers for one attachment fetch. */
export type DaemonFetchAttachmentReply =
  | { v: number; kind: 'fetched'; path: string; filename: string; bytes: number; mimeType: string }
  | { v: number; kind: 'not-followed' }
  | { v: number; kind: 'refused'; message: string }
  | { v: number; kind: 'failed'; message: string };

function isCount(n: unknown, min: number): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= Number.MAX_SAFE_INTEGER;
}

/** Read a `FetchAttachment` request off the wire, or throw. */
export function parseDaemonFetchAttachmentRequest(json: string): DaemonFetchAttachmentRequest {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error('the attachment fetch request is not JSON', { cause: error });
  }
  if (typeof value !== 'object' || value === null)
    throw new Error('the attachment fetch request is not an object');
  const request = value as Partial<DaemonFetchAttachmentRequest>;
  if (request.v !== DAEMON_WIRE_VERSION) {
    throw new Error(
      fmt(
        _(
          'the caller speaks attachment protocol {theirs} and this curlew daemon speaks {ours} — restart it with `systemctl --user restart curlew-daemon`',
        ),
        { theirs: String(request.v), ours: String(DAEMON_WIRE_VERSION) },
      ),
    );
  }
  for (const field of ['backend', 'account', 'remoteId'] as const) {
    if (typeof request[field] !== 'string' || request[field] === '')
      throw new Error(`the attachment fetch request has no ${field}`);
  }
  if (!isCount(request.index, 0)) throw new Error('the attachment fetch request has no index');
  if (!isCount(request.maxBytes, 1)) throw new Error('the attachment fetch request has no maxBytes');
  return request as DaemonFetchAttachmentRequest;
}

/** Read a `FetchAttachment` reply off the wire, or throw. */
export function parseDaemonFetchAttachmentReply(json: string): DaemonFetchAttachmentReply {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error('the curlew daemon answered something that is not JSON', { cause: error });
  }
  if (typeof value !== 'object' || value === null) throw new Error('the curlew daemon answered no object');
  const reply = value as Partial<DaemonFetchAttachmentReply>;
  if (reply.v !== DAEMON_WIRE_VERSION) {
    throw new Error(
      fmt(
        _(
          'the running curlew daemon speaks attachment protocol {theirs} and this curlew speaks {ours} — restart it with `systemctl --user restart curlew-daemon`',
        ),
        { theirs: String(reply.v), ours: String(DAEMON_WIRE_VERSION) },
      ),
    );
  }
  switch (reply.kind) {
    case 'fetched': {
      const payload = reply as Partial<DaemonFetchAttachmentReply> & {
        path?: unknown;
        filename?: unknown;
        bytes?: unknown;
        mimeType?: unknown;
      };
      if (
        typeof payload.path !== 'string' ||
        typeof payload.filename !== 'string' ||
        typeof payload.bytes !== 'number' ||
        typeof payload.mimeType !== 'string'
      )
        throw new Error('the curlew daemon reported a fetch without the file it fetched');
      return reply as DaemonFetchAttachmentReply;
    }
    case 'not-followed':
      return reply as DaemonFetchAttachmentReply;
    case 'refused':
    case 'failed':
      if (typeof (reply as { message?: unknown }).message !== 'string')
        throw new Error('the curlew daemon reported a problem without saying what it was');
      return reply as DaemonFetchAttachmentReply;
    default:
      throw new Error(`the curlew daemon answered an unknown reply kind ${String(reply.kind)}`);
  }
}

/** The most peers one `FetchAvatars` carries: a screenful, so one slow row cannot hold a whole list. */
export const DAEMON_MAX_AVATAR_PEERS = 30;

/** Profile pictures for some chats of one account. New in the same wire version: an old daemon answers `UnknownMethod`. */
export interface DaemonFetchAvatarsRequest {
  v: number;
  backend: string;
  account: string;
  /** Chat addresses as the index holds them (`ListEntry.target`). */
  peers: string[];
  /** Max bytes of one picture. */
  maxBytes: number;
}

/** Where the daemon wrote the picture of a peer, or null when it has none. */
export interface DaemonAvatarFile {
  path: string;
  mimeType: string;
}

export type DaemonFetchAvatarsReply =
  | { v: number; kind: 'fetched'; avatars: Record<string, DaemonAvatarFile | null> }
  | { v: number; kind: 'not-followed' }
  | { v: number; kind: 'failed'; message: string };

/** Read a `FetchAvatars` request off the wire, or throw. */
export function parseDaemonFetchAvatarsRequest(json: string): DaemonFetchAvatarsRequest {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error('the avatar request is not JSON', { cause: error });
  }
  if (typeof value !== 'object' || value === null) throw new Error('the avatar request is not an object');
  const request = value as Partial<DaemonFetchAvatarsRequest>;
  if (request.v !== DAEMON_WIRE_VERSION) throw new Error('the avatar request speaks another protocol version');
  for (const field of ['backend', 'account'] as const) {
    if (typeof request[field] !== 'string' || request[field] === '')
      throw new Error(`the avatar request has no ${field}`);
  }
  if (
    !Array.isArray(request.peers) ||
    request.peers.length === 0 ||
    request.peers.length > DAEMON_MAX_AVATAR_PEERS ||
    request.peers.some((peer) => typeof peer !== 'string' || peer === '')
  )
    throw new Error('the avatar request has no usable peers');
  if (!isCount(request.maxBytes, 1)) throw new Error('the avatar request has no maxBytes');
  return request as DaemonFetchAvatarsRequest;
}

/** Read a `FetchAvatars` reply off the wire, or throw. */
export function parseDaemonFetchAvatarsReply(json: string): DaemonFetchAvatarsReply {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error('the curlew daemon answered something that is not JSON', { cause: error });
  }
  if (typeof value !== 'object' || value === null) throw new Error('the curlew daemon answered no object');
  const reply = value as Partial<DaemonFetchAvatarsReply> & { avatars?: unknown; message?: unknown };
  if (reply.v !== DAEMON_WIRE_VERSION) throw new Error('the running curlew daemon speaks another protocol version');
  switch (reply.kind) {
    case 'fetched': {
      const avatars = reply.avatars;
      if (typeof avatars !== 'object' || avatars === null || Array.isArray(avatars))
        throw new Error('the curlew daemon reported avatars without saying which');
      for (const file of Object.values(avatars as Record<string, unknown>)) {
        if (file === null) continue;
        const f = file as Partial<DaemonAvatarFile>;
        if (typeof f?.path !== 'string' || typeof f.mimeType !== 'string')
          throw new Error('the curlew daemon reported an avatar without its file');
      }
      return reply as DaemonFetchAvatarsReply;
    }
    case 'not-followed':
      return reply as DaemonFetchAvatarsReply;
    case 'failed':
      if (typeof reply.message !== 'string')
        throw new Error('the curlew daemon reported a problem without saying what it was');
      return reply as DaemonFetchAvatarsReply;
    default:
      throw new Error(`the curlew daemon answered an unknown reply kind ${String(reply.kind)}`);
  }
}

/**
 * How long a caller waits for `RequestAccess`: the daemon waits up to 2 minutes for the person
 * (`ACCESS_PROMPT_TIMEOUT_MS`), and the answer has to outlive that or a late "Allow" would find
 * nobody listening. The D-Bus default of 25 s is far too short.
 */
export const DAEMON_ACCESS_TIMEOUT_MS = 150_000;

/** `RequestAccess` carries `AccessAsk` as it is, plus the wire version. */
export type DaemonAccessRequest = AccessAsk & { v: number };

/** `RequestAccess` answers `AccessReply` as it is, plus the wire version. */
export type DaemonAccessReply = AccessReply & { v: number };

const ACCESS_REASONS = ['policy', 'denied', 'denied-before', 'timeout', 'dismissed', 'unavailable'];
const ALLOW_REASONS = ['self', 'rule', 'migrated', 'once', 'session', 'temporary'];

/** Read a `RequestAccess` request off the wire, or throw — the daemon's side of the check. */
export function parseDaemonAccessRequest(json: string): DaemonAccessRequest {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error('the access request is not JSON', { cause: error });
  }
  if (typeof value !== 'object' || value === null) throw new Error('the access request is not an object');
  const request = value as Partial<DaemonAccessRequest>;
  if (request.v !== DAEMON_WIRE_VERSION) {
    throw new Error(
      fmt(
        _(
          'the caller speaks access protocol {theirs} and this curlew daemon speaks {ours} — restart it with `systemctl --user restart curlew-daemon`',
        ),
        { theirs: String(request.v), ours: String(DAEMON_WIRE_VERSION) },
      ),
    );
  }
  for (const field of ['account', 'session'] as const) {
    if (typeof request[field] !== 'string' || request[field] === '')
      throw new Error(`the access request has no ${field}`);
  }
  if (request.kind !== 'read' && request.kind !== 'write') throw new Error('the access request has no kind');
  if (request.contact !== undefined && typeof request.contact !== 'string')
    throw new Error('the access request has a contact that is not a string');
  if (request.preview !== undefined && typeof request.preview !== 'string')
    throw new Error('the access request has a preview that is not a string');
  if (
    request.attachments !== undefined &&
    (!Array.isArray(request.attachments) || request.attachments.some((n) => typeof n !== 'string'))
  )
    throw new Error('the access request has attachments that are not a list of strings');
  return { ...request, oneShot: request.oneShot === true } as DaemonAccessRequest;
}

/** Read a `RequestAccess` reply off the wire, or throw. */
export function parseDaemonAccessReply(json: string): AccessReply {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error('the curlew daemon answered something that is not JSON', { cause: error });
  }
  if (typeof value !== 'object' || value === null) throw new Error('the curlew daemon answered no object');
  const reply = value as Partial<DaemonAccessReply>;
  if (reply.v !== DAEMON_WIRE_VERSION) {
    throw new Error(
      fmt(
        _(
          'the running curlew daemon speaks access protocol {theirs} and this curlew speaks {ours} — restart it with `systemctl --user restart curlew-daemon`',
        ),
        { theirs: String(reply.v), ours: String(DAEMON_WIRE_VERSION) },
      ),
    );
  }
  const reasons = reply.allowed === true ? ALLOW_REASONS : ACCESS_REASONS;
  if (typeof reply.allowed !== 'boolean' || typeof reply.reason !== 'string' || !reasons.includes(reply.reason))
    throw new Error('the curlew daemon answered an access reply this curlew does not understand');
  return { allowed: reply.allowed, reason: reply.reason } as AccessReply;
}
