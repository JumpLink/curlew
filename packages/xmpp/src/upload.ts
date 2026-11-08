/**
 * HTTP File Upload (XEP-0363) — the stanzas and the checks on what the server answers, pure.
 *
 * A file is sent in two steps: ask an upload service for a slot (an IQ), then PUT the bytes to
 * the slot's `put` URL; the message then carries the slot's `get` URL. `client.ts` does the
 * asking and the PUT, `granted.ts` decides what goes into the message. Nothing here touches a
 * socket.
 *
 * The answer is the SERVER's, so it is not trusted: a slot whose URL is not https, carries
 * credentials or points at a private host is refused, and only the three headers the XEP allows
 * are kept (the XEP says to ignore the rest) — a server must not be able to make curlew send
 * an arbitrary header to a host of its choosing.
 */

import xml from '@xmpp/xml';

import { isPublicHost } from './attachment-link.ts';
import { NS, type XmlElement } from './stanza.ts';

export const NS_UPLOAD = 'urn:xmpp:http:upload:0';
const NS_DISCO_ITEMS = 'http://jabber.org/protocol/disco#items';

/** The only headers a slot may ask the PUT to carry (XEP-0363 §4), lower case. */
const SLOT_HEADERS = new Set(['authorization', 'cookie', 'expires']);

export const discoItemsQuery = () => xml('query', { xmlns: NS_DISCO_ITEMS });

/** The JIDs a disco#items answer lists. */
export function parseDiscoItems(query: XmlElement | undefined): string[] {
  const jids: string[] = [];
  for (const item of query?.getChildren('item') ?? []) {
    if (item.attrs.jid) jids.push(item.attrs.jid);
  }
  return jids;
}

/** What a disco#info answer says about file upload. */
export interface UploadService {
  /** The `max-file-size` of the service's data form; null when it states none. */
  maxBytes: number | null;
}

/** The upload service a disco#info answer describes, or null when it offers none. */
export function parseUploadService(query: XmlElement | undefined): UploadService | null {
  if (!query?.getChildren('feature').some((f) => f.attrs.var === NS_UPLOAD)) return null;
  for (const form of query.getChildren('x', NS.data)) {
    const type = form.getChildren('field').find((f) => f.attrs.var === 'FORM_TYPE');
    if (type?.getChildText('value') !== NS_UPLOAD) continue;
    const max = form.getChildren('field').find((f) => f.attrs.var === 'max-file-size');
    const value = Number(max?.getChildText('value'));
    if (Number.isSafeInteger(value) && value > 0) return { maxBytes: value };
  }
  return { maxBytes: null };
}

export interface SlotRequest {
  filename: string;
  size: number;
  contentType: string;
}

export const uploadSlotRequest = (request: SlotRequest) =>
  xml('request', {
    xmlns: NS_UPLOAD,
    filename: request.filename,
    size: String(request.size),
    'content-type': request.contentType,
  });

/** What the PUT carries; the name is only for the error a refusal produces. */
export interface UploadBody {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

/** Where to PUT the bytes and where they can be fetched afterwards. */
export interface UploadSlot {
  putUrl: string;
  getUrl: string;
  /** Only `Authorization`, `Cookie` and `Expires`; every other header the server named is dropped. */
  headers: Record<string, string>;
}

/** An https URL on a public host without credentials, or null — the one rule for both slot URLs. */
export function checkedSlotUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || !isPublicHost(url.hostname)) {
    return null;
  }
  return url.href;
}

/** The slot an upload service answered with, or null when it is not one curlew will use. */
export function parseUploadSlot(slot: XmlElement | undefined): UploadSlot | null {
  const put = slot?.getChild('put');
  const putUrl = checkedSlotUrl(put?.attrs.url);
  const getUrl = checkedSlotUrl(slot?.getChild('get')?.attrs.url);
  if (put === undefined || putUrl === null || getUrl === null) return null;
  // A fragment on the get URL would end up in front of the `aesgcm://` key.
  const getUrlWithoutHash = new URL(getUrl);
  getUrlWithoutHash.hash = '';
  const headers: Record<string, string> = {};
  for (const header of put.getChildren('header')) {
    const name = header.attrs.name?.trim();
    const value = header.text().trim();
    if (name === undefined || !SLOT_HEADERS.has(name.toLowerCase())) continue;
    if (/[\r\n]/.test(value)) return null;
    headers[name] = value;
  }
  return { putUrl, getUrl: getUrlWithoutHash.href, headers };
}
