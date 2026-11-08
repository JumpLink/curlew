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
import { inspectSendFiles } from '@curlew/store';
import { readFileSync } from 'node:fs';
import type { TelegramClientHandle } from './api.ts';
import { remoteMessageId } from './map.ts';

/** Telegram's limit for one text message. curlew refuses longer text rather than split it. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/** Telegram's limit for the caption of a file. A longer text goes out as its own message. */
export const TELEGRAM_MAX_CAPTION_CHARS = 1024;

/** Per file. Telegram takes 2 GB, but the bytes are held in memory while they upload. */
export const TELEGRAM_MAX_FILE_BYTES = 100_000_000;

/** One message holds one file; several files are several messages. */
export const TELEGRAM_MAX_FILES = 10;

/** Telegram refuses a photo over 10 MB; such a picture goes as a document. */
const PHOTO_MAX_BYTES = 10_000_000;

export class TelegramSender implements MessageSender {
  /** Telegram's own formatting is not curlew's chat Markdown: the body goes out as typed. */
  readonly features: SenderFeatures = { markdown: false, attachments: true };
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
    const files = inspectSendFiles(message.attachments ?? [], {
      perFile: TELEGRAM_MAX_FILE_BYTES,
      count: TELEGRAM_MAX_FILES,
    });
    if (message.text.length > TELEGRAM_MAX_MESSAGE_CHARS) {
      throw new Error(
        fmt(_('a Telegram message holds at most {max} characters, this one has {length} — shorten it'), {
          max: String(TELEGRAM_MAX_MESSAGE_CHARS),
          length: String(message.text.length),
        }),
      );
    }
    if (files.length > 0) return this.sendFiles(chatId, message, files);
    const sent = await this.client.sendText(chatId, message.text);
    return {
      target: message.to,
      id: remoteMessageId(chatId, sent.id),
      sentAt: sent.date.toISOString(),
      chatRemoteId: String(chatId),
    };
  }

  /**
   * The files, one message each, the caption on the first. A text too long for a caption follows
   * as its own message. The result is the first message; the rest reach the index with the next sync.
   */
  private async sendFiles(
    chatId: number,
    message: SendingMessage,
    files: ReturnType<typeof inspectSendFiles>,
  ): Promise<SentMessage> {
    const text = message.text.trim().length === 0 ? undefined : message.text;
    const caption = text !== undefined && text.length <= TELEGRAM_MAX_CAPTION_CHARS ? text : undefined;
    let first: Awaited<ReturnType<TelegramClientHandle['sendFile']>> | undefined;
    for (const [index, file] of files.entries()) {
      const sent = await this.client.sendFile(chatId, {
        bytes: readFileSync(file.realPath),
        fileName: file.filename,
        contentType: file.contentType,
        asPhoto:
          (file.contentType === 'image/jpeg' || file.contentType === 'image/png') &&
          file.size <= PHOTO_MAX_BYTES,
        ...(index === 0 && caption !== undefined ? { caption } : {}),
      });
      first ??= sent;
    }
    if (text !== undefined && caption === undefined) await this.client.sendText(chatId, text);
    return {
      target: message.to,
      id: remoteMessageId(chatId, first!.id),
      sentAt: first!.date.toISOString(),
      chatRemoteId: String(chatId),
      attachments: files.map((f) => ({ filename: f.filename, size: f.size })),
    };
  }

  async close(): Promise<void> {
    await this.onClose();
  }
}
