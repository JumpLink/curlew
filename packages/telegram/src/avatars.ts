/**
 * The Telegram backend's profile pictures: the small picture of a chat, streamed into the
 * caller's sink. One connection serves every peer asked, and `close` is the caller's to call.
 *
 * It holds only the read-only `TelegramApi`, like the attachment download.
 */

import { _, type AvatarSource, type ByteSink, fmt } from '@curlew/protocol';
import type { TelegramApi } from './api.ts';

export class TelegramAvatars implements AvatarSource {
  private readonly api: TelegramApi;

  constructor(api: TelegramApi) {
    this.api = api;
  }

  async fetchAvatar(
    peer: string,
    sink: ByteSink,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<{ mimeType: string | null; size: number } | null> {
    const chatId = Number(peer);
    if (!Number.isSafeInteger(chatId)) return null;
    const chunks = await this.api.openAvatar(chatId);
    if (chunks === null) return null;
    let size = 0;
    for await (const chunk of chunks) {
      options.signal?.throwIfAborted();
      size += chunk.byteLength;
      if (size > options.maxBytes) {
        throw new Error(fmt(_('the picture is larger than the limit of {limit} bytes'), { limit: String(options.maxBytes) }));
      }
      await sink.write(chunk);
    }
    return size === 0 ? null : { mimeType: 'image/jpeg', size };
  }

  async close(): Promise<void> {
    await this.api.destroy().catch(() => {});
  }
}
