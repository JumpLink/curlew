import { describe, expect, it } from '@gjsify/unit';

import {
  muteTooltip,
  muteUntil,
  muteView,
  unreadLabel,
} from '../../../src/window/conversation-list-model.ts';
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
  pin: null,
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

    it('says why merge is unavailable', () => {
      const ana = entry({ id: 'a', personIds: ['p-ana'] });
      const bo = entry({ id: 'b', personIds: ['p-bo'] });
      const nobody = entry({ id: 'n', title: 'Chat Example', personIds: [] });
      const group = entry({ id: 'g', kind: 'group' });
      expect(selectionTools([ana, bo]).mergeBlock).toBe(null);
      expect(selectionTools([ana]).mergeBlock).toBe('Select at least two people to merge');
      expect(selectionTools([ana, group]).mergeBlock).toBe('Groups cannot be merged');
      expect(selectionTools([ana, nobody]).mergeBlock).toBe(
        'Chat Example has no person yet, so it cannot be merged',
      );
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

    it('mutes a merged contact on every network and says where it is only partly muted', () => {
      const signal = entry({ id: 's', backend: 'signal', accountId: 'signal-1', muted: true });
      const telegram = entry({ id: 't', backend: 'telegram', accountId: 'telegram-1' });
      const merged = entry({ id: 'm', members: [signal, telegram], unread: 2 });
      expect(muteView(merged).all).toBe(false);
      expect(muteView(merged).on.join()).toBe('Signal');
      expect(muteTooltip(merged)).toBe('Muted on Signal');
      expect(selectionTools([merged]).allMuted).toBe(false);
      const both = entry({ id: 'm', members: [signal, { ...telegram, muted: true }], unread: 2 });
      expect(muteView(both).all).toBe(true);
      expect(muteTooltip(both)).toBe('Muted');
      expect(selectionTools([both, signal]).allMuted).toBe(true);
      expect(selectionTools([both, telegram]).allMuted).toBe(false);
      expect(selectionTools([]).allMuted).toBe(false);
      expect(muteTooltip(telegram)).toBe(null);
      expect(unreadLabel({ ...both, unread: 3 })).toBe('3 unread messages, Muted');
      expect(unreadLabel({ ...telegram, unread: 1 })).toBe('1 unread message');
    });

    it('offers the star away only when every picked row is a favourite', () => {
      const star = entry({ id: 'a', favourite: true });
      const plain = entry({ id: 'b' });
      expect(selectionTools([star]).allFavourite).toBe(true);
      expect(selectionTools([star, plain]).allFavourite).toBe(false);
      expect(selectionTools([]).allFavourite).toBe(false);
    });

    it('turns a mute choice into an absolute end', () => {
      const now = new Date('2026-11-01T00:00:00.000Z');
      expect(muteUntil('hour', now)).toBe('2026-11-01T01:00:00.000Z');
      expect(muteUntil('day', now)).toBe('2026-11-02T00:00:00.000Z');
      expect(muteUntil('week', now)).toBe('2026-11-08T00:00:00.000Z');
      expect(muteUntil('always', now)).toBe(null);
    });
  });
};
