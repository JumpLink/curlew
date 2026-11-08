import { describe, expect, it } from '@gjsify/unit';

import type { ListEntry } from '../../../src/window/conversation-list-model.ts';
import {
  mergeSummary,
  prunePicks,
  selectionTitle,
  selectionTools,
  togglePick,
} from '../../../src/window/selection-model.ts';

const entry = (over: Partial<ListEntry> & { id: string }): ListEntry => ({
  conversationIds: [over.id],
  title: over.id,
  backend: 'signal',
  accountId: 'signal-1',
  kind: 'direct',
  unread: 0,
  lastMessageAt: null,
  target: null,
  emailChat: false,
  room: null,
  members: [],
  personIds: [],
  manual: false,
  ...over,
});

export default async () => {
  describe('selection mode', () => {
    it('counts the picked rows in the header', () => {
      expect(selectionTitle(1)).toBe('1 selected');
      expect(selectionTitle(3)).toBe('3 selected');
    });

    it('offers merge from two people, never with a group or the note to self', () => {
      const ana = entry({ id: 'a', personIds: ['p-ana'] });
      const bo = entry({ id: 'b', personIds: ['p-bo'], backend: 'telegram' });
      const group = entry({ id: 'g', kind: 'group' });
      expect(selectionTools([]).canMerge).toBe(false);
      expect(selectionTools([ana]).canMerge).toBe(false);
      expect(selectionTools([ana, bo]).canMerge).toBe(true);
      expect(selectionTools([ana, bo]).personIds).toStrictEqual(['p-ana', 'p-bo']);
      expect(selectionTools([ana, group]).canMerge).toBe(false);
    });

    it('offers unmerge only when a picked row was merged by hand', () => {
      const plain = entry({ id: 'a', personIds: ['p-ana'] });
      const joined = entry({ id: 'b', personIds: ['p-bo', 'p-bob'], manual: true });
      expect(selectionTools([plain]).canUnmerge).toBe(false);
      expect(selectionTools([joined]).canUnmerge).toBe(true);
      expect(selectionTools([plain, joined]).personIds).toStrictEqual(['p-ana', 'p-bo', 'p-bob']);
    });

    it('names each person with the networks that would join', () => {
      const merged = entry({
        id: 'm',
        title: 'Ana Example',
        personIds: ['p-ana'],
        members: [entry({ id: 'x', backend: 'telegram' }), entry({ id: 'y', backend: 'signal' })],
      });
      const solo = entry({ id: 's', title: 'Bo', backend: 'xmpp', personIds: ['p-bo'] });
      expect(mergeSummary([merged, solo])).toStrictEqual(['Ana Example (Signal · Telegram)', 'Bo (XMPP)']);
    });

    it('toggles a pick and forgets rows that left the list', () => {
      const picked = new Set<string>();
      togglePick(picked, 'a');
      togglePick(picked, 'b');
      togglePick(picked, 'a');
      expect([...picked]).toStrictEqual(['b']);
      prunePicks(picked, [entry({ id: 'c' })]);
      expect(picked.size).toBe(0);
    });
  });
};
