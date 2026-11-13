import { describe, expect, it } from '@gjsify/unit';

import {
  allEmoji,
  emojiGroups,
  filterEmoji,
  groupStarts,
  knownRecent,
  withRecent,
} from '../../../src/window/emoji-model.ts';

export default async () => {
  describe('the emoji picker model', () => {
    it('has the nine groups and well over a thousand emoji', () => {
      expect(emojiGroups().length).toBe(9);
      expect(allEmoji().length > 1500).toBe(true);
    });
    it('leaves out skin-tone variants and component-only entries', () => {
      expect(allEmoji().some((entry) => /[\u{1F3FB}-\u{1F3FF}]/u.test(entry.emoji))).toBe(false);
    });
    it('finds an emoji by its English or German name, every word must match', () => {
      expect(filterEmoji('grinning face').some((entry) => entry.emoji === '😀')).toBe(true);
      expect(filterEmoji('lachen').length > 0).toBe(true);
      expect(filterEmoji('grinning xyzzy').length).toBe(0);
    });
    it('is case-insensitive and returns nothing for an empty query', () => {
      expect(filterEmoji('GRINNING').length).toBe(filterEmoji('grinning').length);
      expect(filterEmoji('  ').length).toBe(0);
    });
    it('keeps the recent list newest first, without duplicates, at most 24', () => {
      expect(withRecent(['a', 'b'], 'b')).toStrictEqual(['b', 'a']);
      const many = Array.from({ length: 30 }, (_v, i) => String(i));
      expect(withRecent(many, 'x').length).toBe(24);
    });
    it('drops stored recents that are not emoji of the data set', () => {
      expect(knownRecent(['😀', 'nope', 3, '👍'])).toStrictEqual(['😀', '👍']);
      expect(knownRecent(undefined)).toStrictEqual([]);
    });
    it('offsets the group starts by the recent row', () => {
      const starts = groupStarts(5);
      expect(starts[0]?.start).toBe(5);
      expect(starts[1]?.start).toBe(5 + (emojiGroups()[0]?.entries.length ?? 0));
    });
  });
};
