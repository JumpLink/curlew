/**
 * Mentions: a named person inside a chat message's text.
 *
 * A mention is a UTF-16 range of the STORED text (what `String.prototype.slice` and GTK's
 * markup both count in) plus the protocol user id of the person. Backends build them while
 * mapping a message; the store keeps them as JSON; the window renders them as links. Everything
 * here is pure.
 */

export interface Mention {
  /** Start of the range in the stored text, in UTF-16 code units. */
  start: number;
  /** End (exclusive) of the range, in UTF-16 code units. */
  end: number;
  /** The mentioned person's id on the network (Matrix user id, Telegram id, Signal ACI, JID …). */
  userId: string;
  /** The mentioned person is the account itself. */
  self?: boolean;
}

/** A mention before its text is final: where it was in the raw text, and who it names. */
export interface RawMention {
  start: number;
  end: number;
  userId: string;
  self?: boolean;
  /** The text to show instead of the range (a name for a placeholder or a bare number). */
  label?: string;
}

/**
 * Keep only usable ranges: integers inside the text, non-empty, in order and not overlapping.
 * Returns undefined when nothing is left, so "no mentions" has one representation.
 */
export function normalizeMentions(text: string, mentions: readonly Mention[] | null | undefined): Mention[] | undefined {
  if (!mentions?.length) return undefined;
  const sorted = [...mentions].sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: Mention[] = [];
  let edge = 0;
  for (const m of sorted) {
    if (!Number.isInteger(m.start) || !Number.isInteger(m.end)) continue;
    if (m.start < edge || m.end <= m.start || m.end > text.length || !m.userId) continue;
    kept.push(m.self ? { start: m.start, end: m.end, userId: m.userId, self: true } : { start: m.start, end: m.end, userId: m.userId });
    edge = m.end;
  }
  return kept.length ? kept : undefined;
}

/**
 * Replace the ranges that carry a `label` (Signal's U+FFFC, WhatsApp's `@<number>`) with that
 * label and move every range to its place in the new text. Ranges without a label keep their
 * text. Invalid or overlapping ranges are dropped.
 */
export function applyMentionLabels(text: string, raw: readonly RawMention[]): { text: string; mentions: Mention[] | undefined } {
  const sorted = [...raw].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let cursor = 0;
  const mentions: Mention[] = [];
  for (const m of sorted) {
    if (!Number.isInteger(m.start) || !Number.isInteger(m.end)) continue;
    if (m.start < cursor || m.end <= m.start || m.end > text.length || !m.userId) continue;
    out += text.slice(cursor, m.start);
    const shown = m.label ? m.label : text.slice(m.start, m.end);
    const start = out.length;
    out += shown;
    cursor = m.end;
    if (shown.length === 0) continue;
    mentions.push(m.self ? { start, end: out.length, userId: m.userId, self: true } : { start, end: out.length, userId: m.userId });
  }
  out += text.slice(cursor);
  return { text: out, mentions: mentions.length ? mentions : undefined };
}

/** Convert an offset counted in code points (XEP-0372, Telegram-style) to UTF-16 code units. */
export function codePointToUtf16(text: string, offset: number): number {
  let units = 0;
  let points = 0;
  while (points < offset && units < text.length) {
    const code = text.codePointAt(units) ?? 0;
    units += code > 0xffff ? 2 : 1;
    points++;
  }
  return units;
}

/** The JSON the store keeps; null when there is nothing to keep. */
export function mentionsToJson(mentions: readonly Mention[] | null | undefined): string | null {
  return mentions?.length ? JSON.stringify(mentions) : null;
}

/** Read the stored JSON back. Anything unreadable is "no mentions": the text still shows. */
export function mentionsFromJson(json: string | null | undefined): Mention[] | undefined {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return undefined;
    const out: Mention[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const { start, end, userId, self } = item as Record<string, unknown>;
      if (typeof start !== 'number' || typeof end !== 'number' || typeof userId !== 'string') continue;
      out.push(self === true ? { start, end, userId, self: true } : { start, end, userId });
    }
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}
