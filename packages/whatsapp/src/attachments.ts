/**
 * The WhatsApp backend's attachment download (ADR 0010 §3): one stored message's file, fetched
 * from WhatsApp's CDN and decrypted with the key the message carried, streamed into the sink.
 *
 * No socket and no session: the downloader is plain HTTPS plus AES-CBC, so a fetch holds nothing
 * the receive loop owns. The one check it can do is on the plaintext — its length and SHA-256,
 * both announced by the sender. The CDN's own digest and MAC over the ciphertext are not checked
 * (Baileys drops the MAC); the plaintext digest covers what a person would open.
 */

import {
  _,
  type AccountRef,
  type AttachmentFetcher,
  type ByteSink,
  type FetchableAttachment,
  fmt,
} from '@curlew/protocol';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { WaMediaDownloader } from './api.ts';
import { parseAttachmentHandle } from './map.ts';

function tooLarge(maxBytes: number): Error {
  return new Error(fmt(_('the attachment is larger than the limit of {limit} bytes'), { limit: String(maxBytes) }));
}

/** The CDN's HTTP status out of a Baileys `Boom`, or null; the message itself quotes a signed URL. */
function statusOf(err: unknown): number | null {
  const e = err as { output?: { statusCode?: unknown }; statusCode?: unknown } | null;
  const status = e?.output?.statusCode ?? e?.statusCode;
  return typeof status === 'number' ? status : null;
}

/** Why the file could not be had, without the error text. */
function unavailable(err: unknown): Error {
  const status = statusOf(err);
  return new Error(
    fmt(_('WhatsApp did not deliver the file ({reason}) — it keeps media only for a limited time'), {
      reason: status === null ? _('download failed') : `HTTP ${status}`,
    }),
  );
}

export class WhatsAppAttachments implements AttachmentFetcher {
  private readonly download: WaMediaDownloader;

  constructor(download: WaMediaDownloader) {
    this.download = download;
  }

  async fetchAttachment(
    _account: AccountRef,
    attachment: FetchableAttachment,
    sink: ByteSink,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<{ mimeType: string | null; size: number }> {
    const handle = parseAttachmentHandle(attachment.handle);
    if (handle === null) throw new Error(_('this WhatsApp attachment cannot be found any more'));
    if (handle.length !== null && handle.length > options.maxBytes) throw tooLarge(options.maxBytes);

    let stream: AsyncIterable<Uint8Array>;
    try {
      stream = await this.download({
        type: handle.type,
        mediaKey: new Uint8Array(Buffer.from(handle.mediaKey, 'base64')),
        directPath: handle.directPath,
        url: handle.url,
      });
    } catch (err) {
      throw unavailable(err);
    }

    const iterator = stream[Symbol.asyncIterator]();
    const digest = createHash('sha256');
    let size = 0;
    try {
      for (;;) {
        options.signal?.throwIfAborted();
        let step: IteratorResult<Uint8Array>;
        try {
          step = await iterator.next();
        } catch (err) {
          throw unavailable(err);
        }
        if (step.done) break;
        size += step.value.byteLength;
        if (size > options.maxBytes) throw tooLarge(options.maxBytes);
        digest.update(step.value);
        await sink.write(step.value);
      }
    } finally {
      // Stops the download when we leave early; a no-op after the last chunk.
      await iterator.return?.().catch(() => {});
    }

    if (handle.length !== null && handle.length !== size) {
      throw new Error(
        fmt(_('the WhatsApp attachment arrived with {actual} bytes, not the announced {announced}'), {
          actual: String(size),
          announced: String(handle.length),
        }),
      );
    }
    if (handle.sha256 !== null && digest.digest('base64') !== handle.sha256) {
      throw new Error(_('the WhatsApp attachment does not match its announced checksum'));
    }
    return { mimeType: null, size };
  }
}
