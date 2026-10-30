/**
 * The Matrix backend's send path: one plain-text `m.room.message` into a room a grant names,
 * behind a saved `matrix.send` grant.
 *
 * The address is the room id exactly as the index and `conversations_list` hold the chat's remote
 * id (`!abc:example.org`), so a grant target `<account>/<address>` matches what a caller reads
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

import {
  _,
  fmt,
  type MessageSender,
  type SendingMessage,
  type SendPermit,
  type SenderFeatures,
  type SentMessage,
} from '@curlew/protocol';

/**
 * The longest text one message may carry. curlew refuses more rather than splitting it.
 *
 * Matrix itself limits the whole event to 65536 bytes (client-server spec, `M_TOO_LARGE`) — the
 * body plus the server's own envelope, which the client cannot measure. 32000 bytes leaves room
 * for any envelope and is well past what a person reads in one message; a longer text is the
 * caller's to divide, because only the caller knows where it may be cut.
 */
export const MATRIX_MAX_MESSAGE_BYTES = 32_000;

/** `!opaque:server` — the shape of a room id (client-server spec §room ids). */
const ROOM_ID = /^![^\s:]+:\S+$/;

const UTF8 = new TextEncoder();

/** The Matrix API version this path speaks; both endpoints it uses are stable in v3. */
const V3 = '/_matrix/client/v3';

/** What one granted sender needs to reach a homeserver. */
export interface MatrixSendSession {
  /** Base URL without a trailing slash, as the account file holds it. */
  homeserver: string;
  accessToken: string;
  /** Already wrapped in `sendFetch` for the permitted rooms by whoever opened the sender. */
  fetch: typeof globalThis.fetch;
}

/** The two requests a send makes. An interface so a test can answer them without HTTP. */
export interface MatrixSendApi {
  /** Does the room have `m.room.encryption` state? Then nothing is sent. */
  isEncrypted(roomId: string): Promise<boolean>;
  /** PUT one `m.room.message`; resolves with the event id the homeserver assigned. */
  sendText(roomId: string, text: string, txnId: string): Promise<string>;
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
    async sendText(roomId, text, txnId) {
      const response = await session.fetch(
        `${room(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
        {
          method: 'PUT',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: 'm.text', body: text }),
        },
      );
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
    },
  };
}

export class MatrixSender implements MessageSender {
  /** Matrix formatting is HTML in a second field, not curlew's chat Markdown: the body goes out as typed. */
  readonly features: SenderFeatures = { markdown: false };
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
    const eventId = await this.api.sendText(roomId, message.text, nextTxnId());
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

  async close(): Promise<void> {
    await this.onClose();
  }
}
