/**
 * The WhatsApp backend's send path: one plain-text 1:1 message, behind a saved `whatsapp.send`
 * grant.
 *
 * The address is a full user JID — `<digits>@lid` or `<digits>@s.whatsapp.net` — exactly as the
 * index and `conversations_list` hold a direct chat's remote id (`JidResolver.chatId`), so a grant
 * target `<account>/<address>` matches what a caller reads back. A bare phone number is not an
 * address here, and neither is a device suffix; `sendableJid` in `jid.ts` says why.
 *
 * The message goes to the JID the permit names, verbatim after normalizing. curlew does NOT
 * rewrite a granted phone-number JID to the LID it knows for it: a grant names one address, and a
 * send to a different one — however equivalent curlew believes the two to be — is not what was
 * granted. The local echo is still filed under the chat id the index uses, because `chatRemoteId`
 * is resolved from the key Baileys hands back, not from the address that was typed.
 *
 * What this path does NOT do, and refuses rather than approximates:
 *
 * - **groups and broadcasts.** A group message needs the sender-key fan-out over a member list
 *   this package does not keep, and a status update is not a chat. Refused by address.
 * - **attachments, captions, reactions, edits, quotes.** The body is the message.
 * - **splitting.** Past `WHATSAPP_MAX_MESSAGE_BYTES` the text is refused, never cut.
 * - **a retry request after the handle closed.** See `getMessage` in `client.ts`.
 *
 * The fan-out is Baileys' own and it is the whole reason this path is thin: `sendMessage`
 * enumerates the recipient's AND this account's devices (a USync query), fetches the pre-keys it
 * has no session for, encrypts once per device, and wraps the copies for the user's own devices in
 * a `deviceSentMessage` so the phone shows what curlew wrote. All of it leaves in ONE stanza, so a
 * throw out of `sendText` means nothing went out.
 *
 * This socket receives, too — the server hands it the offline queue like any other connection —
 * so it maps and journals everything it is given, through the same `subscribeMapped` the receive
 * path uses. Without that, a message that arrived during a send would be acknowledged to WhatsApp
 * and then dropped on close.
 */

import { _, fmt } from '@curlew/protocol';
import type {
  DeliveryEvent,
  MessageSender,
  SendingMessage,
  SendPermit,
  SenderFeatures,
  SentMessage,
} from '@curlew/protocol';
import type { WaEventMap, WaSendSocketHandle } from './api.ts';
import { SERVER_ACK, toNumber } from './api.ts';
import { subscribeMapped } from './events.ts';
import { chatKindOf, parseJid, sendableJid } from './jid.ts';
import type { EventJournal } from './journal.ts';
import { remoteMessageId, type WhatsAppMapper } from './map.ts';

/**
 * The longest text one message may carry. curlew refuses more rather than splitting it.
 *
 * Baileys enforces no limit of its own — it puts whatever string it is given into
 * `conversation`. 65,536 is WhatsApp's own text limit as its clients apply it, and counting UTF-8
 * BYTES is the lower, safe reading of it: a protobuf string field is bytes on the wire, so a text
 * of 65,536 characters with an umlaut in it is over the limit either way round.
 */
export const WHATSAPP_MAX_MESSAGE_BYTES = 65_536;

/** How long a send waits for WhatsApp's `SERVER_ACK` before it answers with a warning. */
const DEFAULT_ACK_MS = 15_000;

const UTF8 = new TextEncoder();

/** A phone number as a person would type one — not an address here, but worth saying so. */
const LOOKS_LIKE_A_NUMBER = /^\+?[\d\s()/.-]+$/;

/** What one granted sender needs. `socket` is already wrapped in the permit gate of `guard.ts`. */
export interface WhatsAppSendSession {
  socket: WaSendSocketHandle;
  mapper: WhatsAppMapper;
  /** The account's receive journal, opened by `openSender` and closed by `onClose`. */
  journal: EventJournal;
  /** Tear down what `openSender` opened. Runs after the socket is ended and the listeners are off. */
  onClose: () => Promise<void> | void;
  /** How long to wait for `SERVER_ACK`; tests shorten it. */
  ackMs?: number;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WhatsAppSender implements MessageSender {
  /**
   * WhatsApp's body is plain text. Its clients render `*bold*` and `_italic_` in it, which is not
   * curlew's chat Markdown and not something this path promises to translate.
   */
  readonly features: SenderFeatures = { markdown: false };
  private readonly socket: WaSendSocketHandle;
  private readonly mapper: WhatsAppMapper;
  private readonly journal: EventJournal;
  private readonly permit: SendPermit;
  private readonly onClose: () => Promise<void> | void;
  private readonly ackMs: number;
  private readonly detach: () => void;
  /** The highest status seen per own message id, from `messages.update`. */
  private readonly acked = new Map<string, number>();
  private ackWaiters: Array<() => void> = [];
  /**
   * Why a message this socket RECEIVED could not be written down. Set once and kept: the journal
   * is what stands between an acknowledged message and its loss, so a send after such a failure
   * would keep taking delivery of messages it cannot store.
   */
  private journalError: string | null = null;
  private closed = false;

  constructor(session: WhatsAppSendSession, permit: SendPermit) {
    this.socket = session.socket;
    this.mapper = session.mapper;
    this.journal = session.journal;
    this.permit = permit;
    this.onClose = session.onClose;
    this.ackMs = session.ackMs ?? DEFAULT_ACK_MS;
    this.socket.ev.on('messages.update', this.onUpdate);
    this.detach = subscribeMapped(this.socket.ev, this.mapper, {
      events: (mapped) => this.record(mapped),
    });
  }

  async send(message: SendingMessage): Promise<SentMessage> {
    const to = this.recipient(message.to);
    const bytes = UTF8.encode(message.text).length;
    if (bytes > WHATSAPP_MAX_MESSAGE_BYTES) {
      throw new Error(
        fmt(_('a WhatsApp message holds at most {max} bytes of text, this one has {bytes} — shorten it'), {
          max: String(WHATSAPP_MAX_MESSAGE_BYTES),
          bytes: String(bytes),
        }),
      );
    }
    // Nothing is sent while a received message is unaccounted for: this connection would go on
    // taking delivery of messages the journal cannot hold, and the server forgets what it handed
    // over. Checked here, before the send, so the refusal means nothing went out.
    if (this.journalError !== null) {
      throw new Error(
        fmt(
          _(
            'a message that arrived while curlew was connected could not be written down ({reason}) — nothing was sent',
          ),
          { reason: this.journalError },
        ),
      );
    }
    // Baileys' `sendNode` throws `Connection Closed` while the WebSocket is not open yet.
    await this.socket.ready();
    const sent = await this.socket.sendText(to, message.text);
    const id = sent.key.id;
    if (!id) {
      throw new Error(
        _(
          'WhatsApp returned no id for the message — it may have been sent; look at the chat before sending it again',
        ),
      );
    }
    // Past this point the stanza is on the wire, so every remaining problem is a warning: a throw
    // would get the message sent a second time by a caller that retries.
    const warnings: string[] = [];
    if (!(await this.waitForAck(id))) {
      warnings.push(
        fmt(
          _(
            'WhatsApp did not confirm the message within {seconds} s — it was handed over, but look at the chat before sending it again',
          ),
          { seconds: String(Math.round(this.ackMs / 1000)) },
        ),
      );
    }
    if (this.journalError !== null) {
      warnings.push(
        fmt(
          _(
            'the message was sent, but a message that arrived at the same time could not be written down ({reason}) — it may be missing from the chat',
          ),
          { reason: this.journalError },
        ),
      );
    }
    const seconds = toNumber(sent.messageTimestamp);
    return {
      target: message.to,
      // What the receive path uses as the remote id of our own messages (`map.ts`), so the copy
      // that comes back replaces curlew's local echo instead of adding a second one.
      id: remoteMessageId(id),
      sentAt: seconds === null ? new Date().toISOString() : new Date(seconds * 1000).toISOString(),
      // The chat as the INDEX files it, resolved from the key Baileys answered with — which is
      // not always the address the grant named: a permit may say the phone-number JID while the
      // chat is filed under the LID, and the echo belongs in the chat a caller can read.
      chatRemoteId: this.mapper.resolver.chatId(sent.key.remoteJid, sent.key.remoteJidAlt) ?? to,
      encrypted: true,
      ...(warnings.length === 0 ? {} : { warning: warnings.join('; ') }),
    };
  }

  async close(): Promise<void> {
    // Idempotent: the app closes the handle in its own finally, and again on an abort.
    if (this.closed) return;
    this.closed = true;
    try {
      // `end()` hands over what Baileys still buffers before it closes, synchronously and while
      // the listeners are still attached — those messages were acknowledged to WhatsApp and exist
      // nowhere else, so they have to reach the journal first.
      this.socket.end();
    } finally {
      this.socket.ev.off('messages.update', this.onUpdate);
      this.detach();
      this.ackWaiters = [];
      await this.onClose();
    }
  }

  /** The JID the permit names, normalized, or a refusal — the permit is checked here again. */
  private recipient(to: string): string {
    const jid = parseJid(to);
    // `status@broadcast` parses as a broadcast JID, so stories are covered by this too.
    if (jid && chatKindOf(jid) === 'broadcast') {
      throw new Error(
        _('curlew does not send status updates or broadcasts — send a message to a person instead'),
      );
    }
    if (jid && chatKindOf(jid) === 'group') {
      throw new Error(
        _(
          'curlew cannot send to a WhatsApp group: a group message is encrypted for every member, and curlew keeps no member list to do that with — send it from WhatsApp',
        ),
      );
    }
    const target = sendableJid(to);
    if (!target) {
      throw new Error(this.addressProblem(to, jid !== null && jid.device !== null));
    }
    if (!this.permit.addresses.some((granted) => sendableJid(granted) === target)) {
      throw new Error(
        fmt(_('sending to {address} is not granted for account {account}'), {
          address: to,
          account: this.permit.account,
        }),
      );
    }
    return target;
  }

  /** Why an address is not sendable, in a sentence that says what to use instead. */
  private addressProblem(to: string, hasDevice: boolean): string {
    if (hasDevice) {
      return fmt(
        _(
          '{address} names one device of a person, not the person — drop the `:<device>` and use the id `conversations_list` shows for the chat',
        ),
        { address: to },
      );
    }
    if (LOOKS_LIKE_A_NUMBER.test(to.trim())) {
      return fmt(
        _(
          '{address} is a phone number, not a WhatsApp chat id — a chat is filed under the LID whenever curlew knows one, so use the id `conversations_list` shows for the chat',
        ),
        { address: to },
      );
    }
    return fmt(
      _(
        '{address} is not a WhatsApp chat id — use the id `conversations_list` shows for the chat (`<digits>@lid` or `<digits>@s.whatsapp.net`)',
      ),
      { address: to },
    );
  }

  /**
   * Journal what this socket received. Mirrors the receive path: the merges the mapper learned
   * come last, so a chat filed under a phone number joins its LID chat even for events mapped
   * before the pair was known.
   */
  private record(mapped: DeliveryEvent[]): void {
    const events = [...mapped, ...this.mapper.takeMerges()];
    if (events.length === 0) return;
    try {
      this.journal.append(events);
    } catch (err) {
      this.journalError ??= reasonOf(err);
    }
  }

  private readonly onUpdate = (updates: WaEventMap['messages.update']): void => {
    let changed = false;
    for (const { key, update } of updates) {
      const status = update.status;
      if (!key.id || typeof status !== 'number') continue;
      if (status <= (this.acked.get(key.id) ?? 0)) continue;
      this.acked.set(key.id, status);
      changed = true;
    }
    if (changed) for (const waiter of [...this.ackWaiters]) waiter();
  };

  /**
   * Wait for WhatsApp to confirm the message (`SERVER_ACK`), or `false` on timeout.
   *
   * Baileys resolves `sendMessage` once the stanza is written to the socket, which is not yet a
   * statement that WhatsApp took it. The confirmation arrives as a `messages.update` carrying our
   * own key — the same event the receive path reads as a receipt — so this listens for it on the
   * raw emitter. The map is filled from the moment the handle opened, so an ack that overtakes
   * `sendMessage`'s own resolution is already there.
   */
  private waitForAck(id: string): Promise<boolean> {
    if ((this.acked.get(id) ?? 0) >= SERVER_ACK) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const check = () => {
        if (settled || (this.acked.get(id) ?? 0) < SERVER_ACK) return;
        settled = true;
        clearTimeout(timer);
        this.ackWaiters = this.ackWaiters.filter((waiter) => waiter !== check);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.ackWaiters = this.ackWaiters.filter((waiter) => waiter !== check);
        resolve(false);
      }, this.ackMs);
      this.ackWaiters.push(check);
    });
  }
}
