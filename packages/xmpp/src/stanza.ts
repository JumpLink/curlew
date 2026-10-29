// xmpp.js ships no types; the declarations must reach every program that bundles this package.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./xmpp-js.d.ts" />
/**
 * The XMPP grammar curlew reads — parsers and request builders, pure.
 *
 * Parsers take a structural `XmlElement`, which xmpp.js's (ltx) elements satisfy and which a
 * test gets by parsing a synthetic stanza. Builders return xmpp.js elements. No socket code here:
 * `client.ts` sends what is built here and hands back what arrived.
 */

import xml from '@xmpp/xml';

/** The slice of an ltx element the parsers read. */
export interface XmlElement {
  name: string;
  attrs: Record<string, string | undefined>;
  getChild(name: string, xmlns?: string): XmlElement | undefined;
  getChildren(name: string, xmlns?: string): XmlElement[];
  getChildText(name: string, xmlns?: string): string | null;
  text(): string;
}

export const NS = {
  mam: 'urn:xmpp:mam:2',
  rsm: 'http://jabber.org/protocol/rsm',
  forward: 'urn:xmpp:forward:0',
  delay: 'urn:xmpp:delay',
  data: 'jabber:x:data',
  roster: 'jabber:iq:roster',
  discoInfo: 'http://jabber.org/protocol/disco#info',
  pubsub: 'http://jabber.org/protocol/pubsub',
  bookmarks: 'urn:xmpp:bookmarks:1',
  privateStorage: 'jabber:iq:private',
  legacyBookmarks: 'storage:bookmarks',
  client: 'jabber:client',
  correct: 'urn:xmpp:message-correct:0',
  retract: 'urn:xmpp:message-retract:1',
  retractLegacy: 'urn:xmpp:message-retract:0',
  fasten: 'urn:xmpp:fasten:0',
  moderate: 'urn:xmpp:message-moderate:1',
  moderateLegacy: 'urn:xmpp:message-moderate:0',
  sid: 'urn:xmpp:sid:0',
  oob: 'jabber:x:oob',
  reply: 'urn:xmpp:reply:0',
  fallback: 'urn:xmpp:fallback:0',
  mucUser: 'http://jabber.org/protocol/muc#user',
  omemoLegacy: 'eu.siacs.conversations.axolotl',
  omemo: 'urn:xmpp:omemo:2',
  openpgp: 'urn:xmpp:openpgp:0',
  pgpLegacy: 'jabber:x:encrypted',
  receipts: 'urn:xmpp:receipts',
  markers: 'urn:xmpp:chat-markers:0',
  carbons: 'urn:xmpp:carbons:2',
  ping: 'urn:xmpp:ping',
  hints: 'urn:xmpp:hints',
  eme: 'urn:xmpp:eme:0',
} as const;

// ── JIDs ────────────────────────────────────────────────────────────────

/** The bare JID, lowercased in its local part and domain (the resource is dropped). */
export function bareJid(jid: string): string {
  return jid.split('/')[0].toLowerCase();
}

/** The resource of a full JID — a MUC occupant's nick — or null. */
export function resourceOf(jid: string): string | null {
  const slash = jid.indexOf('/');
  return slash === -1 ? null : jid.slice(slash + 1);
}

/** The domain of a JID. */
export function domainOf(jid: string): string {
  const bare = bareJid(jid);
  const at = bare.indexOf('@');
  return at === -1 ? bare : bare.slice(at + 1);
}

// ── roster, bookmarks, disco ────────────────────────────────────────────

export interface RosterItem {
  jid: string;
  name: string | null;
  subscription: string;
}

/** The items of a roster result (`<query xmlns='jabber:iq:roster'>`). */
export function parseRoster(query: XmlElement | undefined): RosterItem[] {
  if (!query) return [];
  const items: RosterItem[] = [];
  for (const item of query.getChildren('item')) {
    const jid = item.attrs.jid;
    const subscription = item.attrs.subscription ?? 'none';
    if (!jid || subscription === 'remove') continue;
    items.push({ jid: bareJid(jid), name: item.attrs.name?.trim() || null, subscription });
  }
  return items;
}

export interface Bookmark {
  /** The room's bare JID. */
  jid: string;
  name: string | null;
  /** The user's nick in the room, when the bookmark names one. */
  nick: string | null;
  /** Joined on login: the rooms the user is "in". */
  autojoin: boolean;
}

const truthy = (value: string | undefined): boolean => value === 'true' || value === '1';

/** PEP Native Bookmarks (XEP-0402): `<pubsub><items node='urn:xmpp:bookmarks:1'>`. */
export function parseBookmarks(pubsub: XmlElement | undefined): Bookmark[] {
  const items = pubsub?.getChild('items');
  if (!items) return [];
  const bookmarks: Bookmark[] = [];
  for (const item of items.getChildren('item')) {
    const conference = item.getChild('conference', NS.bookmarks);
    if (!item.attrs.id || !conference) continue;
    bookmarks.push({
      jid: bareJid(item.attrs.id),
      name: conference.attrs.name?.trim() || null,
      nick: conference.getChildText('nick')?.trim() || null,
      autojoin: truthy(conference.attrs.autojoin),
    });
  }
  return bookmarks;
}

/** Legacy bookmarks in private XML storage (XEP-0048 / XEP-0049): `<storage xmlns='storage:bookmarks'>`. */
export function parseLegacyBookmarks(storage: XmlElement | undefined): Bookmark[] {
  if (!storage) return [];
  const bookmarks: Bookmark[] = [];
  for (const conference of storage.getChildren('conference')) {
    if (!conference.attrs.jid) continue;
    bookmarks.push({
      jid: bareJid(conference.attrs.jid),
      name: conference.attrs.name?.trim() || null,
      nick: conference.getChildText('nick')?.trim() || null,
      autojoin: truthy(conference.attrs.autojoin),
    });
  }
  return bookmarks;
}

/** The feature namespaces of a disco#info result. */
export function parseDiscoFeatures(query: XmlElement | undefined): Set<string> {
  const features = new Set<string>();
  for (const feature of query?.getChildren('feature') ?? []) {
    if (feature.attrs.var) features.add(feature.attrs.var);
  }
  return features;
}

export const rosterQuery = () => xml('query', { xmlns: NS.roster });
export const discoInfoQuery = () => xml('query', { xmlns: NS.discoInfo });
export const bookmarksQuery = () => xml('pubsub', { xmlns: NS.pubsub }, xml('items', { node: NS.bookmarks }));
export const legacyBookmarksQuery = () =>
  xml('query', { xmlns: NS.privateStorage }, xml('storage', { xmlns: NS.legacyBookmarks }));

// ── MAM ─────────────────────────────────────────────────────────────────

export interface MamRequest {
  queryId: string;
  /** Only the conversation with this JID (the user's own archive). */
  with?: string;
  /** Only entries at or after this time (ISO 8601). */
  start?: string;
  /** RSM: the page after this archive id (walking forward). */
  after?: string;
  /** RSM: the page before this archive id; the empty string asks for the LAST page. */
  before?: string;
  max: number;
}

function field(name: string, value: string) {
  return xml('field', { var: name }, xml('value', {}, value));
}

/** `<query xmlns='urn:xmpp:mam:2'>` with its data form and result set (XEP-0313, XEP-0059). */
export function mamQuery(request: MamRequest) {
  const fields = [
    xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS.mam)),
    ...(request.with ? [field('with', request.with)] : []),
    ...(request.start ? [field('start', request.start)] : []),
  ];
  const set = xml(
    'set',
    { xmlns: NS.rsm },
    xml('max', {}, String(request.max)),
    ...(request.after !== undefined ? [xml('after', {}, request.after)] : []),
    ...(request.before !== undefined ? [xml('before', {}, request.before)] : []),
  );
  return xml(
    'query',
    { xmlns: NS.mam, queryid: request.queryId },
    xml('x', { xmlns: NS.data, type: 'submit' }, ...fields),
    set,
  );
}

export interface MamFin {
  /** The server says this page is the last one in the direction asked. */
  complete: boolean;
  first: string | null;
  last: string | null;
}

/** The `<fin/>` that ends a MAM query. */
export function parseFin(fin: XmlElement | undefined): MamFin {
  const set = fin?.getChild('set', NS.rsm);
  return {
    complete: truthy(fin?.attrs.complete),
    first: set?.getChildText('first') ?? null,
    last: set?.getChildText('last') ?? null,
  };
}

/** One archived stanza, reduced to what the index needs. */
export interface ArchivedEntry {
  /** The archive's id for it — for a MUC archive also the room's stanza-id. */
  archiveId: string;
  /** Archive time in ms since the epoch, or null when the result carried no delay stamp. */
  stampMs: number | null;
  from: string | null;
  to: string | null;
  type: string | null;
  /** The sender's own stanza id and origin-id (XEP-0359): what 1:1 corrections reference. */
  id: string | null;
  originId: string | null;
  body: string | null;
  /** XEP-0308: the id of the message this one corrects. */
  replaceId: string | null;
  /** XEP-0424 / XEP-0425: the message this one retracts, and whether a moderator did. */
  retract: { id: string; moderated: boolean } | null;
  /** The archive holds only a tombstone where a retracted message was. */
  tombstone: boolean;
  /** Out-of-band URLs (XEP-0066) — what HTTP upload attachments are. */
  attachmentUrls: string[];
  /** XEP-0461: the id of the message this one replies to. */
  replyToId: string | null;
  /** OMEMO / OpenPGP payload: the body is only the sender's fallback text. */
  encrypted: boolean;
  /**
   * The `<encrypted>` element where the message carries OMEMO, so the decrypt pass can reach it
   * without parsing the stanza a second time. Null for OpenPGP, which curlew does not read —
   * which is why {@link ArchivedEntry.encrypted} stays the broader flag of the two.
   *
   * Only the namespace is read here. The grammar inside differs per version and belongs to
   * `omemo-stanza.ts`, which cannot be imported from this module without a cycle.
   */
  omemo: { version: 'legacy' | 'v2'; element: XmlElement } | null;
  /** A MUC occupant's real JID, where the room discloses it. */
  occupantJid: string | null;
}

/**
 * The body without the quote a reply carries as fallback (XEP-0428 for XEP-0461): the range(s)
 * `<fallback for='urn:xmpp:reply:0'><body start end/></fallback>` marks, in Unicode code points.
 * Without such an element the body is returned as it came.
 */
export function stripReplyFallback(message: XmlElement, body: string | null): string | null {
  if (body === null) return null;
  const ranges = message
    .getChildren('fallback', NS.fallback)
    .filter((f) => f.attrs.for === NS.reply)
    .flatMap((f) => f.getChildren('body'))
    .map((b) => [Number(b.attrs.start), Number(b.attrs.end)] as const)
    .filter(([start, end]) => Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start);
  if (ranges.length === 0) return body;
  const chars = Array.from(body);
  const kept = chars.filter((_, i) => !ranges.some(([start, end]) => i >= start && i < end));
  return kept.join('').replace(/^\n/, '');
}

/**
 * A leading `> ` quote block (what clients send as reply fallback, with or without the XEP-0461
 * element): the quoted text without the markers, and the rest of the body. Null when the body
 * does not start with a quote or nothing follows it.
 */
export function leadingQuote(body: string | null): { quoted: string; rest: string } | null {
  if (body === null || !body.startsWith('>')) return null;
  const lines = body.split('\n');
  let n = 0;
  while (n < lines.length && lines[n].startsWith('>')) n++;
  const rest = lines.slice(n).join('\n');
  if (rest.trim() === '') return null;
  const quoted = lines
    .slice(0, n)
    .map((l) => l.replace(/^> ?/, ''))
    .join('\n');
  return { quoted, rest };
}

function retractOf(message: XmlElement): ArchivedEntry['retract'] {
  const retract = message.getChild('retract', NS.retract);
  if (retract?.attrs.id) {
    return { id: retract.attrs.id, moderated: retract.getChild('moderated', NS.moderate) !== undefined };
  }
  // The pre-2023 form: <apply-to xmlns='urn:xmpp:fasten:0' id='…'> with a retract or a
  // moderation inside.
  const applyTo = message.getChild('apply-to', NS.fasten);
  if (applyTo?.attrs.id) {
    if (applyTo.getChild('retract', NS.retractLegacy)) return { id: applyTo.attrs.id, moderated: false };
    const moderated = applyTo.getChild('moderated', NS.moderateLegacy);
    if (moderated?.getChild('retract', NS.retractLegacy)) return { id: applyTo.attrs.id, moderated: true };
  }
  return null;
}

function isTombstone(message: XmlElement): boolean {
  if (message.getChild('retracted', NS.retract)) return true;
  return (
    message.getChild('moderated', NS.moderateLegacy)?.getChild('retracted', NS.retractLegacy) !== undefined
  );
}

function stampOf(forwarded: XmlElement): number | null {
  const stamp = forwarded.getChild('delay', NS.delay)?.attrs.stamp;
  if (!stamp) return null;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One `<message><result xmlns='urn:xmpp:mam:2' queryid='…' id='…'>` of the query `queryId`, or
 * null for any other stanza. `archive` is who must have sent it — the room for a MUC archive,
 * the user's own bare JID (or no `from`) for theirs — so a stranger cannot inject results.
 */
export function parseMamResult(
  stanza: XmlElement,
  queryId: string,
  archive: { jid: string; own: boolean },
): ArchivedEntry | null {
  if (stanza.name !== 'message') return null;
  const result = stanza.getChild('result', NS.mam);
  if (!result || result.attrs.queryid !== queryId || !result.attrs.id) return null;
  const sender = stanza.attrs.from ? bareJid(stanza.attrs.from) : null;
  if (archive.own ? sender !== null && sender !== archive.jid : sender !== archive.jid) return null;
  const forwarded = result.getChild('forwarded', NS.forward);
  const message = forwarded?.getChild('message', NS.client) ?? forwarded?.getChild('message');
  if (!forwarded || !message) return null;

  const oob = message.getChildren('x', NS.oob).flatMap((x) => {
    const url = x.getChildText('url')?.trim();
    return url ? [url] : [];
  });
  const occupant = message.getChild('x', NS.mucUser)?.getChild('item')?.attrs.jid;
  const omemo = omemoOf(message);
  return {
    archiveId: result.attrs.id,
    stampMs: stampOf(forwarded),
    from: message.attrs.from ?? null,
    to: message.attrs.to ?? null,
    type: message.attrs.type ?? null,
    id: message.attrs.id ?? null,
    originId: message.getChild('origin-id', NS.sid)?.attrs.id ?? null,
    body: stripReplyFallback(message, message.getChildText('body')),
    replaceId: message.getChild('replace', NS.correct)?.attrs.id ?? null,
    retract: retractOf(message),
    tombstone: isTombstone(message),
    attachmentUrls: oob,
    replyToId: message.getChild('reply', NS.reply)?.attrs.id ?? null,
    encrypted:
      omemo !== null ||
      message.getChild('openpgp', NS.openpgp) !== undefined ||
      message.getChild('x', NS.pgpLegacy) !== undefined,
    omemo,
    occupantJid: occupant ? bareJid(occupant) : null,
  };
}

/** The message's `<encrypted>` element and which OMEMO version it is in, or null for neither. */
function omemoOf(message: XmlElement): ArchivedEntry['omemo'] {
  const legacy = message.getChild('encrypted', NS.omemoLegacy);
  if (legacy) return { version: 'legacy', element: legacy };
  const v2 = message.getChild('encrypted', NS.omemo);
  return v2 ? { version: 'v2', element: v2 } : null;
}

// ── sending and following (only a handle opened with a grant uses these) ────────────

export interface ChatMessageSpec {
  /** The recipient's bare JID. */
  to: string;
  /** The stanza id, which is also the origin-id (XEP-0359): what MAM's echo is matched by. */
  id: string;
  body: string;
  /** An https URL to attach as an out-of-band reference (XEP-0066): clients show it inline. */
  oobUrl?: string;
}

/**
 * What every 1:1 chat message carries besides its content: `origin-id` (XEP-0359) so the
 * archive's copy can be matched to it, a receipt request (XEP-0184), `markable` (XEP-0333) so
 * the peer's client may answer with markers, and a `store` hint (XEP-0334) so the server
 * archives it.
 *
 * Shared with the OMEMO builder in `omemo-stanza.ts`: an encrypted message is the same message
 * with the text replaced, and an envelope that drifted between the two would show up as our own
 * sent messages going missing from the archive on one path only.
 */
export function chatEnvelope(id: string) {
  return [
    xml('origin-id', { xmlns: NS.sid, id }),
    xml('request', { xmlns: NS.receipts }),
    xml('markable', { xmlns: NS.markers }),
    xml('store', { xmlns: NS.hints }),
  ];
}

/**
 * A 1:1 chat message in plain text, with the envelope above. Not encrypted — the OMEMO one is
 * `encryptedChatMessage` in `omemo-stanza.ts`, and the policy that decides between them is
 * `omemo-send.ts`. With `oobUrl` the message also carries
 * `<x xmlns='jabber:x:oob'><url>…</url></x>`; the caller makes the body that same URL, which is
 * how Conversations, Gajim and Monocles decide to render the file inline instead of as text.
 */
export function chatMessage(spec: ChatMessageSpec) {
  return xml(
    'message',
    { type: 'chat', to: spec.to, id: spec.id },
    xml('body', {}, spec.body),
    ...(spec.oobUrl ? [xml('x', { xmlns: NS.oob }, xml('url', {}, spec.oobUrl))] : []),
    ...chatEnvelope(spec.id),
  );
}

/** Message Carbons (XEP-0280): copies of the account's other clients' traffic, to this session. */
export const carbonsEnable = () => xml('enable', { xmlns: NS.carbons });

/** The follow session's presence: available, but with a negative priority and no status text. */
export const followPresence = () => xml('presence', {}, xml('priority', {}, '-1'));

/**
 * Does this stanza say "something new may be in the archive"? A message with content, plain or
 * in a carbon. It is only ever a wake-up: what is stored comes from the archive (MAM), never from
 * the stanza, so a forged one costs one rate-limited archive query and nothing else.
 */
export function isArrivalHint(stanza: XmlElement): boolean {
  if (stanza.name !== 'message' || stanza.attrs.type === 'error') return false;
  if (stanza.getChild('result', NS.mam)) return false;
  if (stanza.getChild('received', NS.carbons) || stanza.getChild('sent', NS.carbons)) return true;
  return (
    stanza.getChild('body') !== undefined ||
    stanza.getChild('encrypted', NS.omemoLegacy) !== undefined ||
    stanza.getChild('encrypted', NS.omemo) !== undefined
  );
}
