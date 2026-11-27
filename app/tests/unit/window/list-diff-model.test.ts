import { describe, expect, it } from '@gjsify/unit';

import { diffKeys } from '../../../src/window/list-diff-model.ts';

/** Replay the diff on the old list and check it really ends up as the new one. */
function replay(old: readonly string[], next: readonly string[]): string[] {
  const { remove, insert } = diffKeys(old, next);
  const rows = [...old];
  // As `conversation-list.ts` applies it: dropped from the bottom up, then filled top down.
  for (let i = remove.length - 1; i >= 0; i--) rows.splice(remove[i]!, 1);
  for (const at of insert) rows.splice(at, 0, next[at]!);
  return rows;
}

export default async () => {
  describe('the conversation list row diff', () => {
    it('keeps every row of an unchanged list', () => {
      const rows = ['a', 'b', 'c'];
      expect(diffKeys(rows, rows)).toStrictEqual({ remove: [], insert: [] });
    });

    it('builds every row of a list that was empty', () => {
      expect(diffKeys([], ['a', 'b'])).toStrictEqual({ remove: [], insert: [0, 1] });
    });

    it('drops every row when the list empties', () => {
      expect(diffKeys(['a', 'b'], [])).toStrictEqual({ remove: [0, 1], insert: [] });
    });

    it('rebuilds only the row that changed', () => {
      // What a new message does: one row's preview and time differ, the rest draw the same.
      const old = ['a', 'b', 'c', 'd'];
      const diff = diffKeys(old, ['a', 'B!', 'c', 'd']);
      expect(diff).toStrictEqual({ remove: [1], insert: [1] });
      expect(replay(old, ['a', 'B!', 'c', 'd'])).toStrictEqual(['a', 'B!', 'c', 'd']);
    });

    it('keeps the rows a new one is inserted between', () => {
      const old = ['a', 'b', 'c'];
      expect(diffKeys(old, ['a', 'new', 'b', 'c'])).toStrictEqual({ remove: [], insert: [1] });
      expect(replay(old, ['a', 'new', 'b', 'c'])).toStrictEqual(['a', 'new', 'b', 'c']);
    });

    it('keeps the longest run that is already in order', () => {
      // A conversation jumping to the top of the list: only it moves, the rest stay put.
      const old = ['a', 'b', 'c', 'd'];
      const next = ['d', 'a', 'b', 'c'];
      const diff = diffKeys(old, next);
      expect(diff.remove).toStrictEqual([3]);
      expect(diff.insert).toStrictEqual([0]);
      expect(replay(old, next)).toStrictEqual(next);
    });

    it('claims a duplicate key once and builds the second row again', () => {
      // One conversation can show in two sections, so the same key appears twice.
      const old = ['a'];
      const next = ['a', 'a'];
      expect(diffKeys(old, next).insert.length).toBe(1);
      expect(replay(old, next)).toStrictEqual(next);
    });

    it('ends up at the new list for every shuffle of a small one', () => {
      const keys = ['a', 'b', 'c', 'd'];
      const lists: string[][] = [[]];
      // A copy, not the array itself: the loop pushes into `lists` while it walks it.
      for (const key of keys) for (const list of lists.slice()) lists.push([...list, key]);
      for (const old of lists)
        for (const next of lists) {
          expect(replay(old, [...next].reverse())).toStrictEqual([...next].reverse());
          expect(replay(old, next)).toStrictEqual(next);
        }
    });

    it('never builds a row it could have kept', () => {
      // The guarantee the whole fix rests on: a refresh that changes one row of a thousand
      // touches one row, not a thousand.
      const old = Array.from({ length: 1000 }, (_v, i) => `row-${i}`);
      const next = [...old];
      next[500] = 'row-500 changed';
      const diff = diffKeys(old, next);
      expect(diff.remove).toStrictEqual([500]);
      expect(diff.insert).toStrictEqual([500]);
    });
  });
};
