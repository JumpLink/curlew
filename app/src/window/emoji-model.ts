/** The emoji picker's data and filter, without any widget: parsed once, searched in English and German. */

import { EMOJI_DATA } from './emoji-data.ts';

export interface EmojiEntry {
  emoji: string;
  /** The first English word group, used as the accessible label when the language is not German. */
  nameEn: string;
  nameDe: string;
  /** Lower-cased search text: both languages. */
  haystack: string;
}

export interface EmojiGroup {
  id: string;
  icon: string;
  entries: EmojiEntry[];
}

const MAX_RECENT = 24;

let cache: EmojiGroup[] | null = null;

function firstName(text: string): string {
  return (text.split(' | ')[0] ?? '').trim();
}

/** Parse the generated data on first use only; the picker is rarely opened. */
export function emojiGroups(): readonly EmojiGroup[] {
  cache ??= EMOJI_DATA.map((group) => ({
    id: group.id,
    icon: group.icon,
    entries: group.entries.split('\n').map((line): EmojiEntry => {
      const [emoji = '', en = '', de = ''] = line.split('\t');
      return {
        emoji,
        nameEn: firstName(en),
        nameDe: firstName(de) || firstName(en),
        haystack: `${en} | ${de}`.toLowerCase(),
      };
    }),
  }));
  return cache;
}

/** Every emoji in picker order. */
export function allEmoji(): EmojiEntry[] {
  return emojiGroups().flatMap((group) => group.entries);
}

/** The name to read out for `emoji`, in German when `german` is set. */
export function emojiLabel(entry: EmojiEntry, german: boolean): string {
  return german ? entry.nameDe : entry.nameEn;
}

/** Emoji whose name or keywords contain every word of `query` (case-insensitive); none for an empty query. */
export function filterEmoji(query: string): EmojiEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return allEmoji().filter((entry) => words.every((word) => entry.haystack.includes(word)));
}

/** The recent list after `emoji` was picked: newest first, no duplicate, at most {@link MAX_RECENT}. */
export function withRecent(recent: readonly string[], emoji: string): string[] {
  return [emoji, ...recent.filter((one) => one !== emoji)].slice(0, MAX_RECENT);
}

/** Keep only strings that are still emoji of the data set (a stored list may be edited or stale). */
export function knownRecent(stored: readonly unknown[] | undefined): string[] {
  const known = new Set(allEmoji().map((entry) => entry.emoji));
  return (stored ?? []).filter((one): one is string => typeof one === 'string' && known.has(one));
}

/** Index of the first emoji of each group inside the flat list, after `offset` leading entries. */
export function groupStarts(offset: number): { id: string; icon: string; start: number }[] {
  let at = offset;
  return emojiGroups().map((group) => {
    const start = at;
    at += group.entries.length;
    return { id: group.id, icon: group.icon, start };
  });
}
