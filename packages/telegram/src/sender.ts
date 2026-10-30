/**
 * The Telegram backend's send path: one plain-text message, behind a saved `telegram.send` grant.
 *
 * The address is the chat's remote id exactly as the index holds it (`String(peer.id)`: the
 * positive user id of a direct chat, the negative marked id of a group or channel), so a grant
 * target `<account>/<address>` matches what `conversations_list` shows.
 *
 * The permit is checked here again, before anything leaves: a bug above cannot widen a grant.
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
import type { TelegramClientHandle } from './api.ts';

/** Telegram's limit for one text message. curlew refuses longer text rather than split it. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

export class TelegramSender implements MessageSender {
  /** Telegram's own formatting is not curlew's chat Markdown: the body goes out as typed. */
  readonly features: SenderFeatures = { markdown: false };
  private readonly client: TelegramClientHandle;
  private readonly permit: SendPermit;
  private readonly onClose: () => Promise<void>;

  constructor(client: TelegramClientHandle, permit: SendPermit, onClose: () => Promise<void>) {
    this.client = client;
    this.permit = permit;
    this.onClose = onClose;
  }

  /** The chat id the permit names, or a refusal — the permit is the second check. */
  private chatId(to: string): number {
    if (!this.permit.addresses.includes(to) || !/^-?\d+$/.test(to)) {
      throw new Error(
        fmt(_('sending to {address} is not granted for account {account}'), {
          address: to,
          account: this.permit.account,
        }),
      );
    }
    return Number(to);
  }

  async send(message: SendingMessage): Promise<SentMessage> {
    const chatId = this.chatId(message.to);
    if (message.text.length > TELEGRAM_MAX_MESSAGE_CHARS) {
      throw new Error(
        fmt(_('a Telegram message holds at most {max} characters, this one has {length} — shorten it'), {
          max: String(TELEGRAM_MAX_MESSAGE_CHARS),
          length: String(message.text.length),
        }),
      );
    }
    const sent = await this.client.sendText(chatId, message.text);
    return {
      target: message.to,
      id: String(sent.id),
      sentAt: sent.date.toISOString(),
      chatRemoteId: String(chatId),
    };
  }

  async close(): Promise<void> {
    await this.onClose();
  }
}
