/**
 * The Signal backend's attachment download (ADR 0010 §3): one stored message's file, fetched from
 * Signal's CDN and decrypted with the key its pointer carried, written to the caller's sink.
 *
 * No socket and no session: it is plain HTTPS to the CDN plus AES-CBC, so a fetch holds nothing the
 * receive loop owns. `decryptAttachment` checks the digest and the MAC over the whole download
 * before it returns a byte, so the sink never sees unverified data. The download is held in memory,
 * which the size limit bounds.
 */

import {
  _,
  type AccountRef,
  type AttachmentFetcher,
  type ByteSink,
  type FetchableAttachment,
  fmt,
} from '@curlew/protocol';
import { type AttachmentDownloader, attachmentUrl } from './contacts.ts';
import { decryptAttachment } from './crypto.ts';
import { fromBase64 } from './protocol-store.ts';
import { parseAttachmentHandle, pointerOfHandle } from './map.ts';

/** The encrypted file is the plaintext plus padding, IV and MAC: how much larger a download may be. */
const downloadLimit = (maxBytes: number): number => Math.ceil(maxBytes * 1.1) + 64;

const CHUNK = 256 * 1024;

function tooLarge(maxBytes: number): Error {
  return new Error(fmt(_('the attachment is larger than the limit of {limit} bytes'), { limit: String(maxBytes) }));
}

/** Why the CDN gave nothing, without the error text. */
function unavailable(err: unknown): Error {
  const status = /\banswered (\d{3})\b/.exec(err instanceof Error ? err.message : '')?.[1];
  return new Error(
    fmt(_('Signal did not deliver the file ({reason})'), {
      reason: status ? `HTTP ${status}` : _('download failed'),
    }),
  );
}

export class SignalAttachments implements AttachmentFetcher {
  private readonly downloader: (limit: number) => AttachmentDownloader;

  constructor(downloader: (limit: number) => AttachmentDownloader) {
    this.downloader = downloader;
  }

  async fetchAttachment(
    _account: AccountRef,
    attachment: FetchableAttachment,
    sink: ByteSink,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<{ mimeType: string | null; size: number }> {
    const handle = parseAttachmentHandle(attachment.handle);
    if (handle === null) throw new Error(_('this Signal attachment cannot be found any more'));
    if (handle.size !== null && handle.size > options.maxBytes) throw tooLarge(options.maxBytes);

    options.signal?.throwIfAborted();
    let encrypted: Uint8Array;
    try {
      encrypted = await this.downloader(downloadLimit(options.maxBytes))(attachmentUrl(pointerOfHandle(handle)));
    } catch (err) {
      throw unavailable(err);
    }
    options.signal?.throwIfAborted();

    let plain: Uint8Array;
    try {
      plain = decryptAttachment(encrypted, fromBase64(handle.key), { size: handle.size, digest: handle.digest === null ? null : fromBase64(handle.digest) });
    } catch (err) {
      throw new Error(
        fmt(_('the Signal attachment could not be verified ({reason})'), {
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    if (handle.size !== null && plain.byteLength < handle.size) {
      throw new Error(
        fmt(_('the Signal attachment arrived with {actual} bytes, not the announced {announced}'), {
          actual: String(plain.byteLength),
          announced: String(handle.size),
        }),
      );
    }
    if (plain.byteLength > options.maxBytes) throw tooLarge(options.maxBytes);

    for (let at = 0; at < plain.byteLength; at += CHUNK) {
      options.signal?.throwIfAborted();
      await sink.write(plain.subarray(at, at + CHUNK));
    }
    return { mimeType: null, size: plain.byteLength };
  }
}
