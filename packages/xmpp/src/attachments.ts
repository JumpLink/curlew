/**
 * The XMPP backend's attachment download (ADR 0010 §3): one linked file, fetched from the host
 * its sender chose and streamed into the caller's sink.
 *
 * Only after the person tapped (the window never prefetches an XMPP link: a fetch tells the
 * sender's server that and when the message was read), only over `https:`, and never into a
 * private network — a redirect is followed by hand so every hop passes the same checks. An
 * `aesgcm://` file is decrypted with the key from the link; the GCM tag authenticates it before
 * any byte reaches the sink.
 */

import { aesGcmDecrypt } from '@curlew/omemo';
import {
  _,
  type AccountRef,
  type AttachmentFetcher,
  type ByteSink,
  type FetchableAttachment,
  fmt,
} from '@curlew/protocol';
import { isPublicHost, mimeOfName, parseAttachmentHandle } from './attachment-link.ts';

const MAX_REDIRECTS = 3;
const GCM_TAG = 16;
const CHUNK = 256 * 1024;

function tooLarge(maxBytes: number): Error {
  return new Error(fmt(_('the attachment is larger than the limit of {limit} bytes'), { limit: String(maxBytes) }));
}

function refused(reason: string): Error {
  return new Error(fmt(_('the file server refused the download ({reason})'), { reason }));
}

export class XmppAttachments implements AttachmentFetcher {
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  /** The response, following redirects one at a time and checking every target. */
  private async get(start: string, signal?: AbortSignal): Promise<Response> {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const target = new URL(url);
      if (target.protocol !== 'https:' || !isPublicHost(target.hostname)) {
        throw new Error(_('the file is not on a public https server'));
      }
      const response = await this.fetchFn(url, { method: 'GET', redirect: 'manual', signal });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => {});
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok) throw refused(`HTTP ${response.status}`);
      return response;
    }
    throw refused(_('too many redirects'));
  }

  async fetchAttachment(
    _account: AccountRef,
    attachment: FetchableAttachment,
    sink: ByteSink,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<{ mimeType: string | null; size: number }> {
    const link = parseAttachmentHandle(attachment.handle);
    if (link === null) throw new Error(_('this XMPP attachment cannot be found any more'));
    // What arrives is the ciphertext, which carries the GCM tag.
    const limit = options.maxBytes + (link.aesgcm ? GCM_TAG : 0);

    const response = await this.get(link.fetchUrl, options.signal);
    const declared = Number(response.headers.get('content-length'));
    if (response.headers.get('content-length') !== null && Number.isFinite(declared) && declared > limit) {
      throw tooLarge(options.maxBytes);
    }

    const chunks: Uint8Array[] = [];
    let size = 0;
    const take = async (chunk: Uint8Array): Promise<void> => {
      options.signal?.throwIfAborted();
      size += chunk.byteLength;
      if (size > limit) throw tooLarge(options.maxBytes);
      if (link.aesgcm) chunks.push(chunk);
      else await sink.write(chunk);
    };
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await take(value);
      }
    } else {
      await take(new Uint8Array(await response.arrayBuffer()));
    }

    if (link.aesgcm === null) {
      const served = response.headers.get('content-type')?.split(';')[0]?.trim() ?? null;
      // A file server often says nothing useful; the name's extension is the better guess.
      const mimeType = served === null || served === 'application/octet-stream' ? mimeOfName(link.filename) : served;
      return { mimeType, size };
    }

    if (size < GCM_TAG) throw new Error(_('the encrypted attachment is too short'));
    const cipher = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      cipher.set(chunk, at);
      at += chunk.byteLength;
    }
    let plain: Uint8Array;
    try {
      plain = await aesGcmDecrypt(link.aesgcm.key, link.aesgcm.iv, cipher);
    } catch {
      throw new Error(_('the encrypted attachment could not be verified'));
    }
    for (let from = 0; from < plain.byteLength; from += CHUNK) {
      options.signal?.throwIfAborted();
      await sink.write(plain.subarray(from, from + CHUNK));
    }
    return { mimeType: mimeOfName(link.filename), size: plain.byteLength };
  }
}
