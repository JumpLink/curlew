/**
 * The Matrix backend's attachment download (ADR 0010 §3): one `mxc://` file, streamed from the
 * account's own homeserver into the caller's sink.
 *
 * Plain HTTP GETs through the read-only gate — no sync, no crypto store. The own homeserver is
 * always the one asked, even for a file that lives on another: it proxies and caches remote
 * media, and it is the one server this account already trusts with its token.
 *
 * A file from an encrypted room is ciphertext in the repository; its key travelled in the
 * encrypted event and sits in the handle (`attachment-crypto.ts`). That download is verified
 * against the hash from the event and decrypted here — still no crypto store, because the file
 * key is not a Megolm key.
 */

import {
  _,
  type AccountRef,
  type AttachmentFetcher,
  type ByteSink,
  type FetchableAttachment,
  fmt,
} from '@curlew/protocol';
import { decryptAttachment } from './attachment-crypto.ts';
import { errcodeOf } from './errcode.ts';
import { parseAttachmentHandle, parseMxc } from './map.ts';

/** The authenticated media endpoint (Matrix 1.11) and the legacy one older servers still serve. */
const AUTHENTICATED = '/_matrix/client/v1/media/download';
const LEGACY = '/_matrix/media/v3/download';

export interface MatrixAttachmentsSession {
  /** Base URL without a trailing slash, as the account file holds it. */
  homeserver: string;
  accessToken: string;
  /** Already wrapped in `readOnlyFetch`. */
  fetch: typeof globalThis.fetch;
  /** Releases the account file once the fetch is done. */
  onClose?: () => void;
}

/** A refusal for the message; a dead token is marked `loggedOut` so callers can tell it from a flaky server. */
function refusal(reason: string, status: number, errcode: string | null): Error {
  const error = new Error(fmt(_('the homeserver refused the download ({reason})'), { reason }));
  if (errcode === 'M_UNKNOWN_TOKEN' || status === 401) (error as { loggedOut?: boolean }).loggedOut = true;
  return error;
}

function tooLarge(maxBytes: number): Error {
  return new Error(fmt(_('the attachment is larger than the limit of {limit} bytes'), { limit: String(maxBytes) }));
}

export class MatrixAttachments implements AttachmentFetcher {
  private readonly session: MatrixAttachmentsSession;

  constructor(session: MatrixAttachmentsSession) {
    this.session = session;
  }

  /** The media response, trying the authenticated endpoint first and the legacy one if it is unknown. */
  private async download(server: string, mediaId: string, signal?: AbortSignal): Promise<Response> {
    const base = this.session.homeserver.replace(/\/+$/, '');
    const path = `${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`;
    const headers = { Authorization: `Bearer ${this.session.accessToken}` };
    const init: RequestInit = { method: 'GET', headers, signal };
    const first = await this.session.fetch(`${base}${AUTHENTICATED}/${path}`, init);
    if (first.ok) return first;
    const errcode = await errcodeOf(first);
    // A server older than 1.11 does not know the endpoint at all.
    if (first.status !== 404 || (errcode !== null && errcode !== 'M_UNRECOGNIZED')) {
      throw refusal(errcode ?? `HTTP ${first.status}`, first.status, errcode);
    }
    const legacy = await this.session.fetch(`${base}${LEGACY}/${path}?allow_redirect=true`, init);
    if (legacy.ok) return legacy;
    const legacyCode = await errcodeOf(legacy);
    throw refusal(legacyCode ?? `HTTP ${legacy.status}`, legacy.status, legacyCode);
  }

  async fetchAttachment(
    _account: AccountRef,
    attachment: FetchableAttachment,
    sink: ByteSink,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<{ mimeType: string | null; size: number }> {
    try {
      const handle = parseAttachmentHandle(attachment.handle);
      const mxc = handle && parseMxc(handle.mxc);
      if (!handle || !mxc) throw new Error(_('this Matrix attachment cannot be found any more'));
      if (handle.size !== null && handle.size > options.maxBytes) throw tooLarge(options.maxBytes);

      const response = await this.download(mxc.server, mxc.mediaId, options.signal);
      const length = response.headers.get('content-length');
      const declared = Number(length);
      const hasDeclared = length !== null && length.trim() !== '' && Number.isFinite(declared);
      if (hasDeclared && declared > options.maxBytes) throw tooLarge(options.maxBytes);

      // An encrypted file cannot be streamed: the hash covers the WHOLE ciphertext, and bytes
      // handed on before it was checked are bytes the sink already has. So it is buffered —
      // against the same `maxBytes` the stream is — verified, decrypted, and only then written.
      const encrypted = handle.file;
      const ciphertext: Uint8Array[] = [];
      let size = 0;
      const take = async (chunk: Uint8Array): Promise<void> => {
        options.signal?.throwIfAborted();
        size += chunk.byteLength;
        if (size > options.maxBytes) throw tooLarge(options.maxBytes);
        if (encrypted) ciphertext.push(chunk);
        else await sink.write(chunk);
      };
      const reader = response.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await take(value);
          }
        } catch (err) {
          // A refused or aborted download must not leave the connection open behind it.
          await reader.cancel().catch(() => {});
          throw err;
        }
      } else {
        await take(new Uint8Array(await response.arrayBuffer()));
      }

      // The size in the event is only the sending client's hint: clients add or strip metadata
      // after writing it (an EXIF block makes a photo ~90 bytes larger), and the file is still
      // whole. The homeserver's own length is the one a short read is measured against.
      if (hasDeclared && declared !== size) {
        throw new Error(
          fmt(_('the Matrix attachment arrived with {actual} bytes, not the announced {announced}'), {
            actual: String(size),
            announced: String(declared),
          }),
        );
      }
      if (encrypted) {
        const joined = new Uint8Array(size);
        let at = 0;
        for (const chunk of ciphertext) {
          joined.set(chunk, at);
          at += chunk.byteLength;
        }
        const plaintext = await decryptAttachment(joined, encrypted);
        await sink.write(plaintext);
        // The media repository serves ciphertext as `application/octet-stream`; the real type is
        // the one the event announced, which the stored attachment row already carries.
        return { mimeType: null, size: plaintext.byteLength };
      }
      return { mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || null, size };
    } finally {
      this.session.onClose?.();
    }
  }
}
