/**
 * What a link in a chat message says about a file: where to fetch it, and — for an `aesgcm://`
 * link, OMEMO's media sharing — the key that opens it.
 *
 * `https://` links come from out-of-band references (XEP-0066), which HTTP File Upload (XEP-0363)
 * produces. `aesgcm://host/path#<iv><key>` is the same upload, encrypted by the sender; the
 * fragment (12 or 16 bytes of IV, then 32 of key, as hex) never leaves this machine, the file is
 * fetched from `https://host/path`.
 *
 * The sender picks the host. A fetch is the person's own tap (ADR 0010 §3), and even then a link
 * into the person's own network is refused: `isPublicHost` is a cheap guard, not a defence against
 * a host name that resolves to a private address.
 */

import type { AttachmentKind, ChatAttachment } from '@curlew/protocol';

export interface AttachmentLink {
  /** Where the bytes are: always `https:`. */
  fetchUrl: string;
  /** Set for an `aesgcm://` link. */
  aesgcm: { iv: Uint8Array; key: Uint8Array } | null;
  filename: string | null;
}

const HEX = /^(?:[0-9a-f]{2})+$/i;

function unhex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A host that is plausibly on the public internet: not a name or address of this machine or LAN. */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (host.includes(':')) {
    // IPv6: loopback, unspecified, unique-local, link-local and v4-mapped addresses.
    return !(
      host === '::' ||
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb') ||
      host.startsWith('::ffff:')
    );
  }
  // A bare name without a dot is a LAN host; so is a number the URL parser did not normalise.
  return host.includes('.') && !/^[\d.]+$/.test(host);
}

/** The link a message holds, or null when it is not one this backend fetches. */
export function parseAttachmentLink(link: string): AttachmentLink | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'aesgcm:') return null;
  if (url.username !== '' || url.password !== '' || !isPublicHost(url.hostname)) return null;
  let aesgcm: AttachmentLink['aesgcm'] = null;
  if (url.protocol === 'aesgcm:') {
    const fragment = url.hash.slice(1);
    if (!HEX.test(fragment) || (fragment.length !== 88 && fragment.length !== 96)) return null;
    const bytes = unhex(fragment);
    aesgcm = { iv: bytes.subarray(0, bytes.length - 32), key: bytes.subarray(bytes.length - 32) };
  }
  // Not `url.protocol = 'https:'`: the URL standard ignores a switch from a non-special scheme.
  url.hash = '';
  const fetchUrl = url.protocol === 'aesgcm:' ? `https:${url.href.slice('aesgcm:'.length)}` : url.href;
  const last = url.pathname.split('/').filter(Boolean).pop();
  let filename: string | null = null;
  if (last) {
    try {
      filename = decodeURIComponent(last);
    } catch {
      filename = last;
    }
  }
  return { fetchUrl, aesgcm, filename };
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  pdf: 'application/pdf',
};

/** A guess from the file name: all a link gives before it is fetched. */
export function mimeOfName(filename: string | null): string | null {
  const ext = filename?.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined;
  return ext ? (MIME[ext] ?? null) : null;
}

function kindOf(mimeType: string | null): AttachmentKind {
  const major = mimeType?.split('/')[0];
  return major === 'image' || major === 'video' || major === 'audio' ? major : 'file';
}

/** The stored handle: the link as received, which carries everything a fetch needs. */
export function attachmentHandle(link: string): string {
  return JSON.stringify({ url: link });
}

export function parseAttachmentHandle(handle: string): AttachmentLink | null {
  try {
    const value: unknown = JSON.parse(handle);
    const url = (value as { url?: unknown } | null)?.url;
    return typeof url === 'string' ? parseAttachmentLink(url) : null;
  } catch {
    return null;
  }
}

/** One row per link that can be fetched later; a link that cannot be (plain `http:`, a LAN host) gets none. */
export function attachmentsOfLinks(links: readonly string[]): ChatAttachment[] {
  const out: ChatAttachment[] = [];
  for (const link of links) {
    const parsed = parseAttachmentLink(link);
    if (parsed === null) continue;
    const mimeType = mimeOfName(parsed.filename);
    out.push({
      filename: parsed.filename,
      mimeType,
      size: null,
      kind: kindOf(mimeType),
      width: null,
      height: null,
      durationMs: null,
      handle: attachmentHandle(link.trim()),
    });
  }
  return out;
}
