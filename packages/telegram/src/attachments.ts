/**
 * The Telegram backend's attachment download (ADR 0010 §3): one stored message, its media
 * streamed into the caller's sink.
 *
 * It holds only the read-only `TelegramApi`, so a fetch cannot send, edit or delete anything.
 */

import {
  _,
  type AccountRef,
  type AttachmentFetcher,
  type ByteSink,
  type FetchableAttachment,
  fmt,
} from '@curlew/protocol';
import type { TelegramApi } from './api.ts';
import { parseAttachmentHandle } from './map.ts';

export class TelegramAttachments implements AttachmentFetcher {
  private readonly api: TelegramApi;

  constructor(api: TelegramApi) {
    this.api = api;
  }

  async fetchAttachment(
    _account: AccountRef,
    attachment: FetchableAttachment,
    sink: ByteSink,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<{ mimeType: string | null; size: number }> {
    try {
      const ids = parseAttachmentHandle(attachment.handle);
      if (ids === null) throw new Error(_('this Telegram attachment cannot be found any more'));
      const download = await this.api.openMedia(ids.chatId, ids.messageId);
      if (download === null) throw new Error(_('this Telegram attachment cannot be found any more'));

      const { media } = download;
      const announced = media.fileSize ?? null;
      if (announced !== null && announced > options.maxBytes) throw tooLarge(options.maxBytes);

      let size = 0;
      for await (const chunk of download.chunks) {
        options.signal?.throwIfAborted();
        size += chunk.byteLength;
        if (size > options.maxBytes) throw tooLarge(options.maxBytes);
        await sink.write(chunk);
      }
      // A photo's announced size is the largest of several encodings, so only a file's is exact.
      if (media.type !== 'photo' && announced !== null && announced !== size) {
        throw new Error(
          fmt(_('the Telegram attachment arrived with {actual} bytes, not the announced {announced}'), {
            actual: String(size),
            announced: String(announced),
          }),
        );
      }
      return { mimeType: media.type === 'photo' ? 'image/jpeg' : (media.mimeType ?? null), size };
    } finally {
      await this.api.destroy().catch(() => {});
    }
  }
}

function tooLarge(maxBytes: number): Error {
  return new Error(fmt(_('the attachment is larger than the limit of {limit} bytes'), { limit: String(maxBytes) }));
}
