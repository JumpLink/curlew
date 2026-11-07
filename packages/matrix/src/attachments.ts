/**
 * The Matrix backend's attachment download (ADR 0010 §3): one `mxc://` file, streamed from the
 * account's own homeserver into the caller's sink.
 *
 * Plain HTTP GETs through the read-only gate — no sync, no crypto store. The own homeserver is
 * always the one asked, even for a file that lives on another: it proxies and caches remote
 * media, and it is the one server this account already trusts with its token.
 */

import {
  _,
  type AccountRef,
  type AttachmentFetcher,
  type ByteSink,
  type FetchableAttachment,
  fmt,
} from '@curlew/protocol';
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

/** The homeserver's `errcode`, or null when the body is not a Matrix error. */
async function errcodeOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { errcode?: unknown };
    return typeof body.errcode === 'string' ? body.errcode : null;
  } catch {
    return null;
  }
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
      throw new Error(
        fmt(_('the homeserver refused the download ({reason})'), { reason: errcode ?? `HTTP ${first.status}` }),
      );
    }
    const legacy = await this.session.fetch(`${base}${LEGACY}/${path}?allow_redirect=true`, init);
    if (legacy.ok) return legacy;
    const legacyCode = await errcodeOf(legacy);
    throw new Error(
      fmt(_('the homeserver refused the download ({reason})'), { reason: legacyCode ?? `HTTP ${legacy.status}` }),
    );
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
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > options.maxBytes) throw tooLarge(options.maxBytes);

      let size = 0;
      const take = async (chunk: Uint8Array): Promise<void> => {
        options.signal?.throwIfAborted();
        size += chunk.byteLength;
        if (size > options.maxBytes) throw tooLarge(options.maxBytes);
        await sink.write(chunk);
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

      if (handle.size !== null && handle.size !== size) {
        throw new Error(
          fmt(_('the Matrix attachment arrived with {actual} bytes, not the announced {announced}'), {
            actual: String(size),
            announced: String(handle.size),
          }),
        );
      }
      return { mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || null, size };
    } finally {
      this.session.onClose?.();
    }
  }
}
