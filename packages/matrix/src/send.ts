/**
 * The Matrix backend's send path: a plain-text `m.room.message`, or files (an upload and one
 * `m.image`/`m.file` event each), into a room a grant names, behind a saved `matrix.send` grant.
 *
 * The address is the room id exactly as the index and `conversations_list` hold the chat's remote
 * id (`!abc:example.org`, or `!abc` from room version 12 on), so a grant target `<account>/<address>` matches what a caller reads
 * there. Matrix has no second spelling for a room that curlew ever shows — an alias is a label
 * the server resolves, not the chat's identity — so there is nothing to choose between.
 *
 * Plain HTTP, not matrix-js-sdk's `sendEvent`. The SDK would encrypt by itself in an encrypted
 * room, which is exactly the thing this build must not do silently, and it needs a sync loop and
 * a crypto store to do it. One PUT needs none of that: no sync, no WASM crypto, no IndexedDB, and
 * the whole path is unit-testable with a fake fetch on both runtimes.
 *
 * The permit is checked here again, before anything leaves, and the guarded fetch underneath
 * allows only this one endpoint for only these rooms: a bug above cannot widen a grant.
 */

import { readFileSync } from 'node:fs';

import {
  _,
  fmt,
  type MessageSender,
  type SendingMessage,
  type SendPermit,
  type SenderFeatures,
  type SentMessage,
} from '@curlew/protocol';
import { inspectSendFiles, type SendFile } from '@curlew/store';

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
  /** Already wrapped in `sendFetch` for the permitted rooms by whoever opened the sender. */
  fetch: typeof globalThis.fetch;
}

/** One file event: its `msgtype` follows the type, the caption (if any) is the body. */
export interface FileEvent {
  msgtype: 'm.image' | 'm.file';
  /** `mxc://` URI the upload returned. */
  url: string;
  filename: string;
  size: number;
  contentType: string;
  caption?: string;
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
  /** Does the room have `m.room.encryption` state? Then nothing is sent. */
  isEncrypted(roomId: string): Promise<boolean>;
  /** PUT one `m.room.message`; resolves with the event id the homeserver assigned. */
  sendText(roomId: string, text: string, txnId: string, replyTo?: string): Promise<string>;
  /** Upload the bytes to the media repository; resolves with the `mxc://` URI. */
  uploadFile(bytes: Uint8Array, contentType: string, filename: string): Promise<string>;
  /** PUT one `m.image` or `m.file` event for an uploaded file. */
  sendFile(roomId: string, file: FileEvent, txnId: string): Promise<string>;
}

/** The homeserver's `errcode`, or null when the body is not a Matrix error. */
async function errcodeOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { errcode?: unknown };
    return typeof body.errcode === 'string' ? body.errcode : null;
  } catch {
    return null;
  }
}

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

/** The HTTP implementation. The only place this package builds a send request. */
export function matrixSendApi(session: MatrixSendSession): MatrixSendApi {
  const base = session.homeserver.replace(/\/+$/, '');
  const room = (roomId: string): string => `${base}${V3}/rooms/${encodeURIComponent(roomId)}`;
  const auth = { Authorization: `Bearer ${session.accessToken}` };
  const putEvent = async (roomId: string, content: object, txnId: string): Promise<string> => {
    const response = await session.fetch(`${room(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`, {
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
  return {
    async isEncrypted(roomId) {
      // A GET passes the read-only gate unchanged; the state event exists exactly in an
      // encrypted room. M_NOT_FOUND is the server saying there is none.
      const response = await session.fetch(`${room(roomId)}/state/m.room.encryption`, {
        method: 'GET',
        headers: auth,
      });
      if (response.ok) return true;
      const errcode = await errcodeOf(response);
      if (errcode === 'M_NOT_FOUND') return false;
      // Anything else — not joined, server down — is NOT "unencrypted". Refusing here is the
      // safe answer: a message not sent can be sent again, a cleartext one cannot be taken back.
      throw new Error(
        fmt(_('the homeserver did not say whether {room} is encrypted ({reason}) — nothing was sent'), {
          room: roomId,
          reason: reasonOf(response, errcode),
        }),
      );
    },
    async sendText(roomId, text, txnId, replyTo) {
      return putEvent(roomId, { msgtype: 'm.text', body: text, ...relation(replyTo) }, txnId);
    },
    async uploadFile(bytes, contentType, filename) {
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
    },
    async sendFile(roomId, file, txnId) {
      // Since client-server v1.10 `body` may be a caption and `filename` then names the file;
      // without a caption the body is the file name, which every client understands.
      return putEvent(
        roomId,
        {
          msgtype: file.msgtype,
          body: file.caption ?? file.filename,
          filename: file.filename,
          url: file.url,
          info: { mimetype: file.contentType, size: file.size },
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
    reactions: false,
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
    // Before the PUT, and the reason this build refuses rather than falls back: an encrypted room
    // is one the people in it believe nobody else can read. A cleartext `m.room.message` there is
    // readable by the server forever and shows up as a broken message in every client. This
    // build cannot encrypt (no Megolm session here), so the only honest answer is no.
    if (await this.api.isEncrypted(roomId)) {
      throw new Error(
        fmt(
          _(
            '{room} is end-to-end encrypted and curlew cannot send encrypted messages yet — nothing was sent, send it from a Matrix client',
          ),
          { room: roomId },
        ),
      );
    }
    if (files.length > 0) return this.sendFiles(roomId, message, files);
    const eventId = await this.api.sendText(roomId, message.text, nextTxnId(), replyTo);
    return {
      target: message.to,
      id: eventId,
      // The PUT answers with the event id and nothing else; the local clock is what the caller
      // gets, and what it passes back as `since` when it waits for a reply.
      sentAt: new Date().toISOString(),
      chatRemoteId: roomId,
      encrypted: false,
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
  ): Promise<SentMessage> {
    const caption = message.text.trim().length === 0 ? undefined : message.text;
    let first: string | undefined;
    for (const [index, file] of files.entries()) {
      const url = await this.api.uploadFile(readFileSync(file.realPath), file.contentType, file.filename);
      const eventId = await this.api.sendFile(
        roomId,
        {
          msgtype: file.contentType.startsWith('image/') ? 'm.image' : 'm.file',
          url,
          filename: file.filename,
          size: file.size,
          contentType: file.contentType,
          ...(index === 0 && caption !== undefined ? { caption } : {}),
          ...(index === 0 && message.replyTo !== undefined ? { replyTo: message.replyTo.remoteId } : {}),
        },
        nextTxnId(),
      );
      first ??= eventId;
    }
    return {
      target: message.to,
      id: first!,
      sentAt: new Date().toISOString(),
      chatRemoteId: roomId,
      encrypted: false,
      attachments: files.map((f) => ({ filename: f.filename, size: f.size })),
    };
  }

  async close(): Promise<void> {
    await this.onClose();
  }
}
