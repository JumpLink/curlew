import { describe, expect, it } from '@gjsify/unit';

import type { ListEntry } from '../../../src/window/conversation-list-model.ts';
import {
  answerSet,
  candidateSets,
  nameWords,
  personIdsOf,
  similarNames,
} from '../../../src/window/merge-candidates-model.ts';

const person = (id: string, title: string, over: Partial<ListEntry> = {}): ListEntry => ({
  id: `row-${id}`,
  conversationIds: [`c-${id}`],
  title,
  backend: 'signal',
  accountId: 'signal-1',
  kind: 'direct',
  unread: 0,
  lastMessageAt: null,
  target: null,
  emailChat: false,
  room: null,
  members: [],
  personIds: [id],
  manual: false,
  ...over,
});

export default async () => {
  describe('merge candidates', () => {
    it('folds case, diacritics, punctuation and "Last, First"', () => {
      expect(nameWords('  Müller,  Åsa-Maria ')).toStrictEqual(['asa', 'maria', 'muller']);
      expect(nameWords('Example, Ana')).toStrictEqual(['ana', 'example']);
      expect(nameWords('☺ !!')).toStrictEqual([]);
    });

    it('calls the same words in any order similar', () => {
      expect(similarNames('Ana Example', 'example ana')).toBe(true);
      expect(similarNames('Example, Ana', 'Ana Example')).toBe(true);
      expect(similarNames('Ána Example', 'Ana Example')).toBe(true);
    });

    it('accepts a matching first word with a last-word initial, in either direction', () => {
      expect(similarNames('Ana E.', 'Ana Example')).toBe(true);
      expect(similarNames('Ana Example', 'Ana E')).toBe(true);
      expect(similarNames('Ana Z.', 'Ana Example')).toBe(false);
      expect(similarNames('Bo E.', 'Ana Example')).toBe(false);
    });

    it('never matches a single word, an empty name or different people', () => {
      expect(similarNames('Ana', 'Ana Example')).toBe(false);
      expect(similarNames('Ana', 'Ana')).toBe(false);
      expect(similarNames('', '')).toBe(false);
      expect(similarNames('Ana Example', 'Ana Beispiel')).toBe(false);
    });

    it('offers sets of two or more similar people, and nothing else', () => {
      const sets = candidateSets([
        person('p1', 'Ana Example'),
        person('p2', 'Example, Ana', { backend: 'telegram' }),
        person('p3', 'Bo Beispiel'),
        person('p4', 'Ana Example', { kind: 'group', personIds: [] }),
        person('p5', 'Ana Example', { personIds: [] }),
      ]);
      expect(sets.length).toBe(1);
      expect(sets[0]!.entries.map((e) => e.id)).toStrictEqual(['row-p1', 'row-p2']);
      expect(personIdsOf(sets[0]!)).toStrictEqual(['p1', 'p2']);
    });

    it('skips a declined set but offers it again with a newcomer', () => {
      const two = [person('p1', 'Ana Example'), person('p2', 'Example Ana')];
      expect(candidateSets(two, [['p2', 'p1']]).length).toBe(0);
      const three = [...two, person('p3', 'Ana E.')];
      const again = candidateSets(three, [['p1', 'p2']]);
      expect(again.length).toBe(1);
      expect(personIdsOf(again[0]!)).toStrictEqual(['p1', 'p2', 'p3']);
    });

    it('merges the ticked rows and always remembers the whole set', () => {
      const set = candidateSets([
        person('p1', 'Ana Example'),
        person('p2', 'Example Ana'),
        person('p3', 'Ana E.'),
      ])[0]!;
      const all = answerSet(set, new Set(['row-p1', 'row-p2', 'row-p3']));
      expect(all.merge).toStrictEqual(['p1', 'p2', 'p3']);
      const some = answerSet(set, new Set(['row-p1', 'row-p3']));
      expect(some.merge).toStrictEqual(['p1', 'p3']);
      expect(some.decline).toStrictEqual(['p1', 'p2', 'p3']);
      const none = answerSet(set, new Set(['row-p2']));
      expect(none.merge).toStrictEqual([]);
      expect(none.decline).toStrictEqual(['p1', 'p2', 'p3']);
    });

    it('keeps one merged row as one person of a set', () => {
      const merged = person('p1', 'Ana Example', { personIds: ['p1', 'p9'], manual: true });
      const sets = candidateSets([merged, person('p2', 'Ana E.')]);
      expect(personIdsOf(sets[0]!)).toStrictEqual(['p1', 'p2', 'p9']);
    });
  });
};
