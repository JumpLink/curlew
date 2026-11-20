/**
 * Mentions in a bubble: a message's text with its named people as clickable, highlighted names.
 * Pure, so the rules are tested without a window.
 *
 * A mention is a UTF-16 range of the stored text plus a protocol user id (`@curlew/protocol`).
 * The view shows each as a link with the `curlew-mention:` scheme whose number indexes the
 * returned `targets`; activating it opens the person's contact page.
 */

import type { Mention } from '@curlew/protocol';
import type { ListEntry } from './conversation-list-model.ts';
import { escapeMarkup, richMarkup } from './rich-text-model.ts';

export const MENTION_SCHEME = 'curlew-mention:';

/** `text` without its surrounding blanks, and the mentions moved to where they now are. */
export function trimWithMentions(
  text: string,
  mentions: readonly Mention[] | undefined,
): { text: string; mentions: Mention[] | undefined } {
  const lead = text.length - text.trimStart().length;
  const trimmed = text.trim();
  if (!mentions?.length) return { text: trimmed, mentions: undefined };
  const kept = mentions
    .filter((m) => m.start >= lead && m.end <= lead + trimmed.length)
    .map((m) => ({ ...m, start: m.start - lead, end: m.end - lead }));
  return { text: trimmed, mentions: kept.length ? kept : undefined };
}

/** The mentions that lie wholly inside the first `length` characters, as a clipped preview shows. */
export function clipMentions(
  mentions: readonly Mention[] | undefined,
  length: number,
): Mention[] | undefined {
  const kept = mentions?.filter((m) => m.end <= length);
  return kept?.length ? kept : undefined;
}

/** Text that looks like an identifier (a number, a short hex id), not like a name someone wrote. */
const IDENTIFIER_LIKE = /^@(?:\d{5,}|[0-9a-f-]{6,})$/i;

export interface MentionMarkup {
  markup: string;
  /** What each `curlew-mention:<n>` link stands for, in order. */
  targets: Mention[];
  /** The text the label shows without markup, for a name read out or copied. */
  shown: string;
}

/**
 * The text as Pango markup with every mention a link. `nameOf` may know a person by name: it
 * replaces a stand-in that is only an identifier (Signal and WhatsApp send none), never a name
 * the sender's own client wrote. Yours is bold on a faint background; a theme-neutral grey, so
 * light and dark and every accent keep it readable.
 */
export function mentionMarkup(
  text: string,
  mentions: readonly Mention[],
  nameOf: (mention: Mention) => string | null = () => null,
): MentionMarkup {
  let markup = '';
  let shown = '';
  let at = 0;
  const targets: Mention[] = [];
  for (const m of mentions) {
    if (m.start < at || m.end > text.length || m.end <= m.start) continue;
    const before = text.slice(at, m.start);
    markup += richMarkup(before);
    shown += before;
    const written = text.slice(m.start, m.end);
    const name = IDENTIFIER_LIKE.test(written) ? nameOf(m) : null;
    const label = name ? `@${name.replace(/^@/, '')}` : written;
    const link = `<a href="${MENTION_SCHEME}${targets.length}">${escapeMarkup(label)}</a>`;
    markup += m.self ? `<span bgalpha="25%" background="#808080"><b>${link}</b></span>` : link;
    shown += label;
    targets.push(m);
    at = m.end;
  }
  const rest = text.slice(at);
  markup += richMarkup(rest);
  shown += rest;
  return { markup, targets, shown };
}

/** The index a `curlew-mention:` link carries, or null for any other link. */
export function mentionIndex(uri: string): number | null {
  if (!uri.startsWith(MENTION_SCHEME)) return null;
  const n = Number(uri.slice(MENTION_SCHEME.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The forms a user id takes in the index: as sent, lowercase, and without a JID's server and device. */
function keys(userId: string): string[] {
  const lower = userId.toLowerCase().replace(/^xmpp:/, '');
  const bare = lower
    .replace(/^pni:/, '')
    .replace(/[:/]\d+(?=@)/, '')
    .replace(/@(?:s\.whatsapp\.net|lid)$/, '');
  return [...new Set([userId, lower, bare])];
}

/**
 * The one-to-one chat of the mentioned person, whose entry the contact page opens from: the
 * direct row on the same account kind whose people include that id. Null for someone the index
 * has no chat with (the view then shows a minimal profile).
 */
export function mentionEntry(
  entries: readonly ListEntry[],
  backend: string,
  mention: Mention,
): ListEntry | null {
  const wanted = new Set(keys(mention.userId));
  const flat = entries.flatMap((e) => (e.members.length > 0 ? e.members : [e]));
  const found = flat.find(
    (e) =>
      e.kind === 'direct' &&
      e.backend === backend &&
      (e.people ?? []).some((p) => p.addresses.some((a) => keys(a).some((k) => wanted.has(k)))),
  );
  if (!found) return null;
  return entries.find((e) => e.id === found.id || e.members.some((m) => m.id === found.id)) ?? found;
}

/** The name the index has for a mentioned person, when a chat with them exists. */
export function mentionName(entries: readonly ListEntry[], backend: string, mention: Mention): string | null {
  const wanted = new Set(keys(mention.userId));
  const flat = entries.flatMap((e) => (e.members.length > 0 ? e.members : [e]));
  for (const e of flat) {
    if (e.backend !== backend) continue;
    for (const p of e.people ?? []) {
      if (p.name && p.addresses.some((a) => keys(a).some((k) => wanted.has(k)))) return p.name;
    }
  }
  return null;
}
