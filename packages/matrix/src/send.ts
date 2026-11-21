/**
 * The Matrix backend's send path: a text `m.room.message`, or files (an upload and one
 * `m.image`/`m.file` event each), into a room a grant names, behind a saved `matrix.send` grant.
 *
 * The address is the room id exactly as the index and `conversations_list` hold the chat's remote
 * id (`!abc:example.org`, or `!abc` from room version 12 on), so a grant target `<account>/<address>` matches what a caller reads
 * there. Matrix has no second spelling for a room that curlew ever shows — an alias is a label
 * the server resolves, not the chat's identity — so there is nothing to choose between.
 *
 * TWO transports, chosen per room (ADR 0019):
 *   - A CLEAR room: plain HTTP, one PUT per event. No sync loop, no WASM crypto, no IndexedDB,
 *     and the whole path is unit-testable with a fake fetch on both runtimes.
 *   - An ENCRYPTED room: the `MatrixEncrypt` surface of a live client, which is the only thing
 *     that holds the Megolm session. Without one — no daemon running — the send is REFUSED.
 *
 * What never happens is the third option: an encrypted room does not get a cleartext event. The
 * room is asked before every content event, a `true` is cached (encryption cannot be turned off
 * again), an unclear answer refuses, and `putEvent` itself throws rather than PUT an
 * `m.room.message` into a room it knows is encrypted. A reaction, a redaction and a read receipt
 * stay in the clear because Matrix has no encrypted form of them.
 *
 * The permit is checked here again, before anything leaves, and the guarded fetch underneath
 * allows only these endpoints for only these rooms: a bug above cannot widen a grant.
 */

import { readFileSync } from 'node:fs';

import {
  _,
  type ChatAttachment,
  fmt,
  type MessageSender,
  probeMediaFile,
  type SendingDeletion,
  type SendingEdit,
  type SendingMessage,
  type SendingReaction,
  type SendingReadSync,
  type SendPermit,
  type SenderFeatures,
  type SentMessage,
} from '@curlew/protocol';
import { inspectSendFiles, type SendFile } from '@curlew/store';

import type { MatrixEncrypt } from './api.ts';
import { type EncryptedFile, encryptAttachment } from './attachment-crypto.ts';
import { attachmentHandle, attachmentKind } from './map.ts';
import { errcodeOf } from './errcode.ts';

/**
 * The longest text one message may carry. curlew refuses more rather than splitting it.
 *
 * Matrix itself limits the whole event to 65536 bytes (client-server spec, `M_TOO_LARGE`) — the
 * body plus the server's own envelope, which the client cannot measure. 32000 bytes leaves room
 * for any envelope and is well past what a person reads in one message; a longer text is the
 * caller's to divide, because only the caller knows where it may be cut.
 */
export const MATRIX_MAX_MESSAGE_BYTES = 32_000;

/**
 * What one file may weigh. Synapse's default `max_upload_size` is 50 MB and other servers differ;
 * a bigger file is refused here before the bytes are read, a smaller one the server may still
 * refuse (`M_TOO_LARGE`), which the error then names.
 */
export const MATRIX_MAX_FILE_BYTES = 50_000_000;

/** How many files one message may carry; each becomes its own event. */
export const MATRIX_MAX_FILES = 10;

/**
 * `!opaque:server`, or just `!opaque` from room version 12 on (MSC4291: the id is the create
 * event's hash, with no server part) — the shape of a room id (client-server spec §room ids).
 */
const ROOM_ID = /^![^\s:]+(:\S+)?$/;

const UTF8 = new TextEncoder();

/** The Matrix API version this path speaks; both endpoints it uses are stable in v3. */
const V3 = '/_matrix/client/v3';

/** The media repository's upload endpoint; it lives outside `/client/`. */
const UPLOAD = '/_matrix/media/v3/upload';

/** What one granted sender needs to reach a homeserver. */
export interface MatrixSendSession {
  /** Base URL without a trailing slash, as the account file holds it. */
  homeserver: string;
  accessToken: string;
  /** The account's own Matrix id: which reactions in a room are the person's. */
  userId: string;
  /** Already wrapped in `sendFetch` for the permitted rooms by whoever opened the sender. */
  fetch: typeof globalThis.fetch;
}

/** One file event: its `msgtype` follows the type, the caption (if any) is the body. */
export interface FileEvent {
  msgtype: 'm.image' | 'm.video' | 'm.audio' | 'm.file';
  /** `mxc://` URI the upload returned — a CLEAR room only; an encrypted one carries `file`. */
  url?: string;
  /** The uploaded ciphertext and its key, for an encrypted room. Exactly one of the two is set. */
  file?: EncryptedFile;
  filename: string;
  size: number;
  contentType: string;
  caption?: string;
  width?: number;
  height?: number;
  /** Milliseconds, as `info.duration` takes them. */
  durationMs?: number;
  /** An Ogg Opus mono voice note (MSC3245). */
  voice?: boolean;
  /** The event this one answers (`m.in_reply_to`). */
  replyTo?: string;
}

/** An event id (`$…`), the only kind `m.in_reply_to` takes. */
const EVENT_ID = /^\$\S+$/;

/** The relation that makes an event a reply (client-server spec, rich replies). */
const relation = (replyTo: string | undefined): object =>
  replyTo === undefined ? {} : { 'm.relates_to': { 'm.in_reply_to': { event_id: replyTo } } };

/** The requests a send makes. An interface so a test can answer them without HTTP. */
export interface MatrixSendApi {
  /**
   * Whether this api could encrypt at all: true when a live client with the crypto store is
   * behind it. False means an encrypted room is refused instead of sent (ADR 0019 §1).
   */
  readonly canEncrypt: boolean;
  /**
   * Must events in this room be encrypted? The crypto's own persistent flag first, the room's
   * `m.room.encryption` state as the fallback. Throws when the answer is unclear — a send then
   * fails rather than guessing cleartext.
   */
  isEncrypted(roomId: string): Promise<boolean>;
  /** Send one `m.room.message`, encrypted where the room asks for it; resolves with the event id. */
  sendText(roomId: string, text: string, txnId: string, replyTo?: string): Promise<string>;
  /** Upload the bytes to the media repository; resolves with the `mxc://` URI. */
  uploadFile(bytes: Uint8Array, contentType: string, filename: string): Promise<string>;
  /**
   * Encrypt the bytes, upload the ciphertext, and resolve with the `file` object the event has to
   * carry instead of `url` — for a room that is encrypted (ADR 0019 §6). The media repository is
   * not encrypted, so a file there is only as private as this.
   */
  uploadEncryptedFile(bytes: Uint8Array, filename: string): Promise<EncryptedFile>;
  /** Send one `m.image` or `m.file` event for an uploaded file, encrypted where the room asks. */
  sendFile(roomId: string, file: FileEvent, txnId: string): Promise<string>;
  /** PUT one `m.reaction` (an `m.annotation` with `key`) on `eventId`; resolves with its event id. */
  sendReaction(roomId: string, eventId: string, key: string, txnId: string): Promise<string>;
  /** The person's own reactions on `eventId`, as the homeserver holds them (redacted ones are not listed). */
  ownReactions(roomId: string, eventId: string): Promise<OwnReaction[]>;
  /** PUT an `m.replace` of `eventId` with the new `text`; resolves with the edit's event id. */
  sendEdit(roomId: string, eventId: string, text: string, txnId: string): Promise<string>;
  /** Redact one event: takes a reaction back, or deletes a message for everyone. */
  redact(roomId: string, eventId: string, txnId: string): Promise<void>;
  /** POST a PRIVATE read receipt (`m.read.private`) up to `eventId`: only the person's own devices see it. */
  sendPrivateReadReceipt(roomId: string, eventId: string): Promise<void>;
}

/** One reaction of the person: the event that carries it and its emoji. */
export interface OwnReaction {
  eventId: string;
  key: string;
}

/** How many pages of reactions (100 each) are read to find the person's own. */
const RELATION_PAGES = 5;

/** `M_FORBIDDEN` or `HTTP 503` — never the response body, which can quote the message. */
function reasonOf(response: Response, errcode: string | null): string {
  return errcode ?? `HTTP ${response.status}`;
}

let txnCounter = 0;

/**
 * A transaction id, unique per send. Matrix uses it to deduplicate a retried PUT, so two
 * different messages must never share one: the clock alone is not enough (two sends in the same
 * millisecond), hence the counter and the random tail.
 */
export function nextTxnId(): string {
  txnCounter += 1;
  return `curlew-${Date.now()}-${txnCounter}-${Math.floor(Math.random() * 1e9)}`;
}

/** The content event type: the one thing that is never sent in the clear in an encrypted room. */
const MESSAGE = 'm.room.message';

/** What the person is told when an encrypted room has nobody to encrypt for it. */
function noCryptoHere(roomId: string): Error {
  return new Error(
    fmt(
      _(
        '{room} is end-to-end encrypted, and encrypted messages are sent by the curlew daemon, which is not running — start it and send again; nothing was sent',
      ),
      { room: roomId },
    ),
  );
}

/**
 * The implementation. The only place this package builds a send request.
 *
 * `encrypt` is the live client's surface (ADR 0019 §1) and is absent without one: then an
 * encrypted room is refused. The two transports are chosen HERE, per event and per room, so no
 * caller can pick the wrong one: `sendText`, `sendEdit` and `sendFile` all pass through
 * `putMessage`, which asks the room before it decides.
 */
export function matrixSendApi(session: MatrixSendSession, encrypt?: MatrixEncrypt): MatrixSendApi {
  const base = session.homeserver.replace(/\/+$/, '');
  const room = (roomId: string): string => `${base}${V3}/rooms/${encodeURIComponent(roomId)}`;
  const auth = { Authorization: `Bearer ${session.accessToken}` };
  /**
   * Rooms this api has PROVEN encrypted. A `true` never expires: encryption cannot be turned off
   * again, so the answer stays right however long this api lives — and it is also what the
   * `putEvent` backstop below reads.
   */
  const provenEncrypted = new Set<string>();
  /**
   * Rooms this api has seen NO `m.room.encryption` in. Remembered only because the answer is
   * asked twice per send — once by the sender, which refuses a room it cannot encrypt before it
   * builds or uploads anything, and once by `putMessage`, which decides the transport.
   *
   * Safe because this api is built per granted sender handle (`openSender` in backend.ts) and a
   * handle is opened and closed around ONE send operation: the answer cannot go stale between
   * two messages, because two messages never share it.
   */
  const provenClear = new Set<string>();
  const putEvent = async (
    roomId: string,
    content: object,
    txnId: string,
    type = MESSAGE,
  ): Promise<string> => {
    // The backstop for the one rule of ADR 0019 §2. Every content event reaches the wire through
    // `putMessage`, which has already asked; this catches a future path that forgets to.
    if (type === MESSAGE && provenEncrypted.has(roomId)) {
      throw new Error(
        fmt(_('{room} is end-to-end encrypted — refusing to send a readable message there'), {
          room: roomId,
        }),
      );
    }
    const response = await session.fetch(`${room(roomId)}/send/${type}/${encodeURIComponent(txnId)}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(content),
    });
    if (!response.ok) {
      const errcode = await errcodeOf(response);
      throw new Error(
        fmt(_('the homeserver refused the message to {room} ({reason})'), {
          room: roomId,
          reason: reasonOf(response, errcode),
        }),
      );
    }
    const body = (await response.json()) as { event_id?: unknown };
    if (typeof body.event_id !== 'string' || body.event_id.length === 0) {
      throw new Error(
        fmt(_('the homeserver accepted the message to {room} but returned no event id'), { room: roomId }),
      );
    }
    return body.event_id;
  };
  const isEncrypted = async (roomId: string): Promise<boolean> => {
    if (provenEncrypted.has(roomId)) return true;
    if (provenClear.has(roomId)) return false;
    // The crypto's flag is persistent and cannot be downgraded, so its `true` is proof. Its
    // `false` is not: a room this device has not synced answers false too, hence the state read.
    if (encrypt !== undefined && (await encrypt.knownEncrypted(roomId))) {
      provenEncrypted.add(roomId);
      return true;
    }
    // A GET passes the read-only gate unchanged; the state event exists exactly in an
    // encrypted room. M_NOT_FOUND is the server saying there is none.
    const response = await session.fetch(`${room(roomId)}/state/m.room.encryption`, {
      method: 'GET',
      headers: auth,
    });
    if (response.ok) {
      provenEncrypted.add(roomId);
      return true;
    }
    const errcode = await errcodeOf(response);
    if (errcode === 'M_NOT_FOUND') {
      provenClear.add(roomId);
      return false;
    }
    // Anything else — not joined, server down — is NOT "unencrypted". Refusing here is the
    // safe answer: a message not sent can be sent again, a cleartext one cannot be taken back.
    throw new Error(
      fmt(_('the homeserver did not say whether {room} is encrypted ({reason}) — nothing was sent'), {
        room: roomId,
        reason: reasonOf(response, errcode),
      }),
    );
  };
  const uploadFile = async (bytes: Uint8Array, contentType: string, filename: string): Promise<string> => {
    const response = await session.fetch(`${base}${UPLOAD}?filename=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': contentType },
      // A file read from disk is never backed by a SharedArrayBuffer, which is all the cast drops.
      body: bytes as Uint8Array<ArrayBuffer>,
    });
    if (!response.ok) {
      const errcode = await errcodeOf(response);
      throw new Error(
        fmt(_('the homeserver refused the file {file} ({reason})'), {
          file: filename,
          reason: reasonOf(response, errcode),
        }),
      );
    }
    const body = (await response.json()) as { content_uri?: unknown };
    if (typeof body.content_uri !== 'string' || !body.content_uri.startsWith('mxc://')) {
      throw new Error(
        fmt(_('the homeserver accepted the file {file} but returned no media URI'), { file: filename }),
      );
    }
    return body.content_uri;
  };
  /**
   * One content event. The room decides the transport: the live client's crypto where it is
   * encrypted, the plain PUT where it provably is not, and a refusal where the answer is unclear
   * or nothing here can encrypt.
   */
  const putMessage = async (roomId: string, content: object, txnId: string): Promise<string> => {
    if (!(await isEncrypted(roomId))) return putEvent(roomId, content, txnId);
    if (encrypt === undefined) throw noCryptoHere(roomId);
    // Device lists and the room key first, so the ciphertext is not built against a stale set of
    // devices and the first message of a session does not wait with the event already in hand.
    await encrypt.prepare(roomId);
    return encrypt.sendMessage(roomId, content as Record<string, unknown>);
  };
  return {
    canEncrypt: encrypt !== undefined,
    isEncrypted,
    async sendText(roomId, text, txnId, replyTo) {
      return putMessage(roomId, { msgtype: 'm.text', body: text, ...relation(replyTo) }, txnId);
    },
    async sendPrivateReadReceipt(roomId, eventId) {
      const response = await session.fetch(
        `${room(roomId)}/receipt/m.read.private/${encodeURIComponent(eventId)}`,
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!response.ok) {
        const errcode = await errcodeOf(response);
        throw new Error(
          fmt(_('the homeserver refused the read marker in {room} ({reason})'), {
            room: roomId,
            reason: reasonOf(response, errcode),
          }),
        );
      }
    },
    async sendReaction(roomId, eventId, key, txnId) {
      return putEvent(
        roomId,
        { 'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key } },
        txnId,
        'm.reaction',
      );
    },
    async sendEdit(roomId, eventId, text, txnId) {
      // An edit carries the new text, so it is a content event like the first one: encrypted
      // where the room is encrypted, and never a cleartext replacement of a ciphertext message.
      return putMessage(
        roomId,
        {
          msgtype: 'm.text',
          // The fallback body for clients that do not know `m.replace`.
          body: `* ${text}`,
          'm.new_content': { msgtype: 'm.text', body: text },
          'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
        },
        txnId,
      );
    },
    async ownReactions(roomId, eventId) {
      const found: OwnReaction[] = [];
      let from: string | undefined;
      for (let page = 0; page < RELATION_PAGES; page += 1) {
        const query = `limit=100${from === undefined ? '' : `&from=${encodeURIComponent(from)}`}`;
        const response = await session.fetch(
          `${base}/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(eventId)}/m.annotation/m.reaction?${query}`,
          { method: 'GET', headers: auth },
        );
        if (!response.ok) {
          const errcode = await errcodeOf(response);
          throw new Error(
            fmt(_('the homeserver did not list the reactions in {room} ({reason}) — nothing was sent'), {
              room: roomId,
              reason: reasonOf(response, errcode),
            }),
          );
        }
        const body = (await response.json()) as { chunk?: unknown; next_batch?: unknown };
        for (const item of Array.isArray(body.chunk) ? body.chunk : []) {
          const event = item as {
            event_id?: unknown;
            sender?: unknown;
            content?: { 'm.relates_to'?: { key?: unknown } };
          };
          const key = event.content?.['m.relates_to']?.key;
          if (event.sender === session.userId && typeof event.event_id === 'string' && typeof key === 'string') {
            found.push({ eventId: event.event_id, key });
          }
        }
        if (typeof body.next_batch !== 'string' || body.next_batch.length === 0) break;
        from = body.next_batch;
      }
      return found;
    },
    async redact(roomId, eventId, txnId) {
      const response = await session.fetch(
        `${room(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`,
        {
          method: 'PUT',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: '{}',
        },
      );
      if (!response.ok) {
        const errcode = await errcodeOf(response);
        throw new Error(
          fmt(_('the homeserver did not redact the event in {room} ({reason})'), {
            room: roomId,
            reason: reasonOf(response, errcode),
          }),
        );
      }
    },
    uploadFile,
    async uploadEncryptedFile(bytes, filename) {
      const { ciphertext, file } = await encryptAttachment(bytes);
      // The repository sees opaque bytes and the real type stays inside the event, so the upload
      // announces none. The file NAME is sent as before: the server already knows it from the
      // request a clear upload makes, and a client that hides it shows "Encrypted file" instead.
      const url = await uploadFile(ciphertext, 'application/octet-stream', filename);
      return { url, ...file };
    },
    async sendFile(roomId, file, txnId) {
      if (file.url === undefined && file.file === undefined) {
        throw new Error(_('a Matrix file event needs an uploaded file — nothing was sent'));
      }
      // Since client-server v1.10 `body` may be a caption and `filename` then names the file;
      // without a caption the body is the file name, which every client understands.
      return putMessage(
        roomId,
        {
          msgtype: file.msgtype,
          body: file.caption ?? file.filename,
          filename: file.filename,
          // `url` in a clear room, `file` in an encrypted one — the spec allows exactly one, and
          // a client that reads the wrong field would download bytes it has no key for.
          ...(file.file === undefined ? { url: file.url } : { file: file.file }),
          info: {
            mimetype: file.contentType,
            size: file.size,
            ...(file.width !== undefined ? { w: file.width } : {}),
            ...(file.height !== undefined ? { h: file.height } : {}),
            ...(file.durationMs !== undefined ? { duration: file.durationMs } : {}),
          },
          ...(file.voice === true
            ? {
                'org.matrix.msc3245.voice': {},
                ...(file.durationMs !== undefined
                  ? { 'org.matrix.msc1767.audio': { duration: file.durationMs } }
                  : {}),
              }
            : {}),
          ...relation(file.replyTo),
        },
        txnId,
      );
    },
  };
}

export class MatrixSender implements MessageSender {
  /** Matrix formatting is HTML in a second field, not curlew's chat Markdown: the body goes out as typed. */
  readonly features: SenderFeatures = {
    markdown: false,
    attachments: true,
    replies: true,
    reactions: true,
    edits: true,
    deletes: true,
    readSync: true,
  };
  private readonly api: MatrixSendApi;
  private readonly permit: SendPermit;
  private readonly onClose: () => Promise<void>;

  constructor(api: MatrixSendApi, permit: SendPermit, onClose: () => Promise<void>) {
    this.api = api;
    this.permit = permit;
    this.onClose = onClose;
  }

  /** The room the permit names, or a refusal — the permit is the second check. */
  private roomId(to: string): string {
    if (!this.permit.addresses.includes(to) || !ROOM_ID.test(to)) {
      throw new Error(
        fmt(_('sending to {address} is not granted for account {account}'), {
          address: to,
          account: this.permit.account,
        }),
      );
    }
    return to;
  }

  /**
   * Whether this room's content events must be encrypted — asked BEFORE anything is built, so a
   * room nothing here can encrypt is refused while the message is still only a string.
   *
   * The refusal matters as much as the encryption: an encrypted room is one the people in it
   * believe nobody else can read. A cleartext event there is readable by the server forever and
   * shows up as a broken message in every client, so "send it in the clear instead" is not an
   * option this code has (ADR 0019 §2).
   */
  private async mustEncrypt(roomId: string): Promise<boolean> {
    if (!(await this.api.isEncrypted(roomId))) return false;
    if (!this.api.canEncrypt) throw noCryptoHere(roomId);
    return true;
  }

  async send(message: SendingMessage): Promise<SentMessage> {
    const roomId = this.roomId(message.to);
    const files = inspectSendFiles(message.attachments ?? [], {
      perFile: MATRIX_MAX_FILE_BYTES,
      count: MATRIX_MAX_FILES,
    });
    const replyTo = message.replyTo?.remoteId;
    if (replyTo !== undefined && !EVENT_ID.test(replyTo)) {
      throw new Error(fmt(_('{id} is not a Matrix event id — nothing was sent'), { id: replyTo }));
    }
    const bytes = UTF8.encode(message.text).length;
    if (bytes > MATRIX_MAX_MESSAGE_BYTES) {
      throw new Error(
        fmt(_('a Matrix message holds at most {max} bytes of text, this one has {bytes} — shorten it'), {
          max: String(MATRIX_MAX_MESSAGE_BYTES),
          bytes: String(bytes),
        }),
      );
    }
    const encrypted = await this.mustEncrypt(roomId);
    if (files.length > 0) return this.sendFiles(roomId, message, files, encrypted);
    const eventId = await this.api.sendText(roomId, message.text, nextTxnId(), replyTo);
    return {
      target: message.to,
      id: eventId,
      // The send answers with the event id and nothing else; the local clock is what the caller
      // gets, and what it passes back as `since` when it waits for a reply.
      sentAt: new Date().toISOString(),
      chatRemoteId: roomId,
      encrypted,
    };
  }

  /**
   * One event per file, the text as the caption of the first. The result is the first event;
   * the others reach the index with the next sync.
   */
  private async sendFiles(
    roomId: string,
    message: SendingMessage,
    files: readonly SendFile[],
    encrypted: boolean,
  ): Promise<SentMessage> {
    const caption = message.text.trim().length === 0 ? undefined : message.text;
    let first: string | undefined;
    const echoAttachments: ChatAttachment[] = [];
    for (const [index, file] of files.entries()) {
      const probe = probeMediaFile(file.realPath, file.contentType);
      const major = file.contentType.split('/')[0];
      const msgtype = probe.voice
        ? 'm.audio'
        : major === 'image'
          ? 'm.image'
          : major === 'video'
            ? 'm.video'
            : major === 'audio'
              ? 'm.audio'
              : 'm.file';
      const durationMs = probe.durationMs === null ? undefined : Math.round(probe.durationMs);
      const bytes = readFileSync(file.realPath);
      // In an encrypted room the repository must never see the file itself: it is encrypted with
      // its own key, and that key exists only in the (encrypted) event — and in the handle below.
      const encryptedFile = encrypted ? await this.api.uploadEncryptedFile(bytes, file.filename) : null;
      const url = encryptedFile
        ? encryptedFile.url
        : await this.api.uploadFile(bytes, file.contentType, file.filename);
      const eventId = await this.api.sendFile(
        roomId,
        {
          msgtype,
          ...(encryptedFile ? { file: encryptedFile } : { url }),
          filename: file.filename,
          size: file.size,
          contentType: file.contentType,
          ...(probe.width !== null ? { width: probe.width } : {}),
          ...(probe.height !== null ? { height: probe.height } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(probe.voice ? { voice: true } : {}),
          ...(index === 0 && caption !== undefined ? { caption } : {}),
          ...(index === 0 && message.replyTo !== undefined ? { replyTo: message.replyTo.remoteId } : {}),
        },
        nextTxnId(),
      );
      // The same row the sync writes for this event, so the delivered copy adopts the echo cleanly.
      echoAttachments.push({
        filename: file.filename,
        mimeType: file.contentType,
        size: file.size,
        kind: attachmentKind(msgtype, file.contentType, probe.voice),
        width: probe.width,
        height: probe.height,
        durationMs: durationMs ?? null,
        handle: attachmentHandle(url, file.size, encryptedFile ?? undefined),
      });
      first ??= eventId;
    }
    return {
      target: message.to,
      id: first!,
      sentAt: new Date().toISOString(),
      chatRemoteId: roomId,
      encrypted,
      attachments: files.map((f) => ({ filename: f.filename, size: f.size })),
      echoAttachments,
    };
  }

  /**
   * The person's emoji on a message, replacing their earlier one: Matrix lets one person leave
   * several, so the others are redacted first, and giving an emoji already there sends nothing.
   * Taking it back redacts the reaction events that carry it (all of the person's, when `previous`
   * is not named). The homeserver's own list says which events those are.
   *
   * Cleartext even in an encrypted room, and not a leak this code could avoid: Matrix has no
   * encrypted reaction (the emoji and the event it sits on are server-visible by design, which is
   * why every client shows them in an encrypted room), so there is nothing here to refuse.
   */
  async react(reaction: SendingReaction): Promise<void> {
    const roomId = this.roomId(reaction.to);
    const target = reaction.target.remoteId;
    if (!EVENT_ID.test(target)) {
      throw new Error(fmt(_('{id} is not a Matrix event id — nothing was sent'), { id: target }));
    }
    const own = await this.api.ownReactions(roomId, target);
    const keep = reaction.emoji;
    for (const mine of own) {
      const gone = keep === null ? reaction.previous === undefined || mine.key === reaction.previous : mine.key !== keep;
      if (gone) await this.api.redact(roomId, mine.eventId, nextTxnId());
    }
    if (keep !== null && !own.some((mine) => mine.key === keep)) {
      await this.api.sendReaction(roomId, target, keep, nextTxnId());
    }
  }

  /** The event id of a message of the person's own, or a refusal before anything is sent. */
  private ownEvent(target: { remoteId: string; fromSelf?: boolean }): string {
    if (!EVENT_ID.test(target.remoteId)) {
      throw new Error(fmt(_('{id} is not a Matrix event id — nothing was sent'), { id: target.remoteId }));
    }
    if (target.fromSelf !== true) {
      throw new Error(_('only your own messages can be changed — nothing was sent'));
    }
    return target.remoteId;
  }

  /**
   * Replaces the text of one of the person's own messages; the new content rides an `m.replace`
   * event — which carries the text, so it is encrypted wherever the first one was.
   */
  async edit(edit: SendingEdit): Promise<void> {
    const roomId = this.roomId(edit.to);
    const eventId = this.ownEvent(edit.target);
    if (UTF8.encode(edit.text).length > MATRIX_MAX_MESSAGE_BYTES) {
      throw new Error(_('the edited text is too long for one Matrix message — nothing was sent'));
    }
    await this.mustEncrypt(roomId);
    await this.api.sendEdit(roomId, eventId, edit.text, nextTxnId());
  }

  /**
   * Deletes one of the person's own messages for everyone, by redaction. A redaction is cleartext
   * in every room: it names an event and removes it, and Matrix has no encrypted form of that.
   */
  async delete(deletion: SendingDeletion): Promise<void> {
    const roomId = this.roomId(deletion.to);
    const eventId = this.ownEvent(deletion.target);
    await this.api.redact(roomId, eventId, nextTxnId());
  }

  /**
   * How far the person read, for their own devices only: a PRIVATE receipt, which the homeserver
   * never shows to other members. Not message content, so an encrypted room needs no refusal.
   */
  async readSync(sync: SendingReadSync): Promise<void> {
    const roomId = this.roomId(sync.to);
    const eventId = sync.target.remoteId;
    if (!EVENT_ID.test(eventId)) {
      throw new Error(fmt(_('{id} is not a Matrix event id — nothing was sent'), { id: eventId }));
    }
    await this.api.sendPrivateReadReceipt(roomId, eventId);
  }

  async close(): Promise<void> {
    await this.onClose();
  }
}
