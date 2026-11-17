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
  type ChatAttachment,
  type MessageSender,
  probeMediaFile,
  type ReplyTarget,
  type SendingDeletion,
  type SendingEdit,
  type SendingMessage,
  type SendingReaction,
  type SendingReadSync,
  type SendPermit,
  type SenderFeatures,
  type SentMessage,
} from '@curlew/protocol';
import { inspectSendFiles } from '@curlew/store';
import { readFileSync } from 'node:fs';
import type { TelegramClientHandle } from './api.ts';
import { remoteMessageId, toChatAttachments } from './map.ts';

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

/**
 * The message number in a reply target (`<chat>/<number>`, as `remoteMessageId` writes it). A target
 * in another chat is refused: Telegram would answer a message of the wrong conversation.
 */
function replyNumber(chatId: number, remoteId: string): number {
  const match = /^(-?\d+)\/(\d+)$/.exec(remoteId);
  if (!match || Number(match[1]) !== chatId) {
    throw new Error(fmt(_('{id} is not a message of this Telegram chat — nothing was sent'), { id: remoteId }));
  }
  return Number(match[2]);
}

export class TelegramSender implements MessageSender {
  /** Telegram's own formatting is not curlew's chat Markdown: the body goes out as typed. */
  readonly features: SenderFeatures = {
    markdown: false,
    attachments: true,
    replies: true,
    reactions: true,
    edits: true,
    deletes: true,
    readSync: true,
  };
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
    const replyTo = message.replyTo && replyNumber(chatId, message.replyTo.remoteId);
    if (files.length > 0) return this.sendFiles(chatId, message, files, replyTo);
    const sent = await this.client.sendText(chatId, message.text, replyTo);
    return {
      target: message.to,
      id: remoteMessageId(chatId, sent.id),
      sentAt: sent.date.toISOString(),
      chatRemoteId: String(chatId),
    };
  }

  /**
   * The person's emoji on a message, replacing their earlier one (Telegram keeps one per person
   * outside Premium); `null` takes it back. Telegram names its reactions without the emoji
   * variation selector (`❤`), so it is dropped before the call.
   */
  async react(reaction: SendingReaction): Promise<void> {
    const chatId = this.chatId(reaction.to);
    const emoji = reaction.emoji === null ? null : reaction.emoji.replaceAll('\uFE0F', '');
    try {
      await this.client.sendReaction(chatId, replyNumber(chatId, reaction.target.remoteId), emoji);
    } catch (err) {
      // Read structurally, like the FLOOD_WAIT in session.ts: a fake client throws a plain object.
      const text = (err as { text?: unknown } | null)?.text;
      if (text === 'PREMIUM_ACCOUNT_REQUIRED') {
        throw new Error(_('Telegram allows reactions here only with Premium (for example in Saved Messages)'));
      }
      if (text === 'REACTION_INVALID') {
        throw new Error(_('this chat does not allow that reaction'));
      }
      throw err;
    }
  }

  /** The message number of a message of the person's own, or a refusal before anything is sent. */
  private ownNumber(chatId: number, target: ReplyTarget): number {
    const number = replyNumber(chatId, target.remoteId);
    if (target.fromSelf !== true) {
      throw new Error(_('only your own messages can be changed — nothing was sent'));
    }
    return number;
  }

  /** Replaces the text of one of the person's own messages. */
  async edit(edit: SendingEdit): Promise<void> {
    const chatId = this.chatId(edit.to);
    const number = this.ownNumber(chatId, edit.target);
    if (edit.text.length > TELEGRAM_MAX_MESSAGE_CHARS) {
      throw new Error(
        fmt(_('a Telegram message holds at most {max} characters, this one has {length} — shorten it'), {
          max: String(TELEGRAM_MAX_MESSAGE_CHARS),
          length: String(edit.text.length),
        }),
      );
    }
    await this.client.editMessage(chatId, number, edit.text);
  }

  /** Marks the chat read up to the newest read message (Telegram has no private form; ADR 0004). */
  async readSync(sync: SendingReadSync): Promise<void> {
    const chatId = this.chatId(sync.to);
    if (sync.target.fromSelf === true) return;
    await this.client.readHistory(chatId, replyNumber(chatId, sync.target.remoteId));
  }

  /** Deletes one of the person's own messages for everyone. */
  async delete(deletion: SendingDeletion): Promise<void> {
    const chatId = this.chatId(deletion.to);
    await this.client.deleteMessage(chatId, this.ownNumber(chatId, deletion.target));
  }

  /**
   * The files, one message each, the caption on the first. A text too long for a caption follows
   * as its own message. The result is the first message; the rest reach the index with the next sync.
   */
  private async sendFiles(
    chatId: number,
    message: SendingMessage,
    files: ReturnType<typeof inspectSendFiles>,
    replyTo: number | undefined,
  ): Promise<SentMessage> {
    const text = message.text.trim().length === 0 ? undefined : message.text;
    const caption = text !== undefined && text.length <= TELEGRAM_MAX_CAPTION_CHARS ? text : undefined;
    let first: Awaited<ReturnType<TelegramClientHandle['sendFile']>> | undefined;
    const echo: ChatAttachment[] = [];
    for (const [index, file] of files.entries()) {
      const asPhoto =
        (file.contentType === 'image/jpeg' || file.contentType === 'image/png') && file.size <= PHOTO_MAX_BYTES;
      const probe = asPhoto ? null : probeMediaFile(file.realPath, file.contentType);
      const as = asPhoto ? undefined : sendAs(file.contentType, probe);
      const sent = await this.client.sendFile(chatId, {
        bytes: readFileSync(file.realPath),
        fileName: file.filename,
        contentType: file.contentType,
        asPhoto,
        ...(as === undefined ? {} : { as }),
        ...(as !== undefined && probe?.width ? { width: probe.width } : {}),
        ...(as !== undefined && probe?.height ? { height: probe.height } : {}),
        ...(as !== undefined && probe?.durationMs ? { duration: Math.round(probe.durationMs / 1000) } : {}),
        ...(index === 0 && caption !== undefined ? { caption } : {}),
        ...(index === 0 && replyTo !== undefined ? { replyTo } : {}),
      });
      first ??= sent;
      echo.push(...(toChatAttachments(sent) ?? []));
    }
    if (text !== undefined && caption === undefined) await this.client.sendText(chatId, text);
    return {
      target: message.to,
      id: remoteMessageId(chatId, first!.id),
      sentAt: first!.date.toISOString(),
      chatRemoteId: String(chatId),
      attachments: files.map((f) => ({ filename: f.filename, size: f.size })),
      ...(echo.length > 0 ? { echoAttachments: echo } : {}),
    };
  }

  async close(): Promise<void> {
    await this.onClose();
  }
}

/** How a non-photo file goes out: a voice note (Ogg Opus, mono), a video, an audio file, else a document. */
function sendAs(contentType: string, probe: { voice: boolean } | null): 'video' | 'audio' | 'voice' | undefined {
  if (probe?.voice) return 'voice';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return undefined;
}
