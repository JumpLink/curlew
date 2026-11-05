import { describe, expect, it } from '@gjsify/unit';
import type { Conversation } from '@curlew/protocol';

import {
  type ListEntry,
  NO_FILTER,
  accountChoices,
  backendChoices,
  buildSections,
  entryTitle,
  initials,
  protocolIcon,
  protocolLabel,
  shortTime,
  toEntry,
  unreadText,
  unreadTier,
} from '../../../src/window/conversation-list-model.ts';

// Synthetic conversations only.
function conversation(over: Partial<Conversation> & { id: string }): Conversation {
  return {
    backend: 'xmpp',
    accountId: 'xmpp-abc123',
    kind: 'direct',
    title: null,
    participants: [],
    classification: 'conversational',
    classificationReason: 'default',
    firstMessageAt: null,
    lastMessageAt: null,
    messageCount: 1,
    unreadCount: 0,
    hasAttachments: false,
    ...over,
  } as Conversation;
}

const entry = (over: Partial<ListEntry> & { id: string }): ListEntry => ({
  title: over.id,
  backend: 'xmpp',
  accountId: 'xmpp-abc123',
  kind: 'direct',
  unread: 0,
  lastMessageAt: null,
  ...over,
});

const ids = (list: ListEntry[]): string[] => list.map((e) => e.id);

export default async () => {
  describe('conversation list model', () => {
    it('has a distinct badge icon per protocol', () => {
      const icons = ['mail', 'xmpp', 'signal', 'matrix', 'telegram', 'whatsapp'].map(protocolIcon);
      expect(new Set(icons).size).toBe(6);
    });

    it('shows a short time: clock today, a word for yesterday, else the date', () => {
      const now = new Date(2026, 10, 5, 15, 0);
      expect(shortTime(new Date(2026, 10, 5, 9, 5).toISOString(), now)).toBe('09:05');
      expect(shortTime(new Date(2026, 10, 4, 23, 0).toISOString(), now)).toBe('Yesterday');
      expect(shortTime(new Date(2026, 9, 30, 12, 0).toISOString(), now)).toBe('2026-10-30');
      expect(shortTime(null, now)).toBe('');
      expect(shortTime('nonsense', now)).toBe('');
    });

    it('titles a conversation by stored title, then people, then a fallback', () => {
      expect(entryTitle(conversation({ id: 'a', title: '  Team  ' }))).toBe('Team');
      const people = conversation({
        id: 'b',
        participants: [
          { id: 'p1', displayName: 'Anna Example', addresses: [], contactUid: null },
          {
            id: 'p2',
            displayName: null,
            addresses: [{ kind: 'email', value: 'ben@example.org' }],
            contactUid: null,
          },
        ],
      } as Partial<Conversation> & { id: string });
      expect(entryTitle(people)).toBe('Anna Example, ben@example.org');
      expect(entryTitle(conversation({ id: 'c' }))).toBe('Unnamed conversation');
    });

    it('clamps a negative unread count and tiers by it', () => {
      expect(toEntry(conversation({ id: 'a', unreadCount: -3 })).unread).toBe(0);
      expect(unreadTier(entry({ id: 'a', unread: 2 }))).toBe('count');
      expect(unreadTier(entry({ id: 'a' }))).toBe('none');
      expect(unreadText(7)).toBe('7');
      expect(unreadText(150)).toBe('99+');
    });

    it('splits into people and groups, newest first, undated last', () => {
      const sections = buildSections([
        entry({ id: 'old', lastMessageAt: '2026-01-01T00:00:00Z' }),
        entry({ id: 'none' }),
        entry({ id: 'new', lastMessageAt: '2026-02-01T00:00:00Z' }),
        entry({ id: 'g1', kind: 'group', lastMessageAt: '2026-01-05T00:00:00Z', unread: 1 }),
      ]);
      expect(sections.map((s) => s.id).join(',')).toBe('people,groups');
      expect(ids(sections[0]!.entries).join(',')).toBe('new,old,none');
      expect(sections[1]!.unread).toBe(1);
    });

    it('leaves out empty sections', () => {
      const sections = buildSections([entry({ id: 'g', kind: 'group' })]);
      expect(sections.length).toBe(1);
      expect(sections[0]!.id).toBe('groups');
      expect(buildSections([]).length).toBe(0);
    });

    it('filters by protocol, account and text', () => {
      const all = [
        entry({ id: 'a', title: 'Anna', backend: 'xmpp' }),
        entry({ id: 'b', title: 'Ben', backend: 'mail', accountId: 'mail-def456' }),
        entry({ id: 'c', title: 'Annika', backend: 'mail', accountId: 'mail-zzz999' }),
      ];
      const flat = (f: Parameters<typeof buildSections>[1]) =>
        ids(buildSections(all, f).flatMap((s) => s.entries))
          .sort()
          .join(',');
      expect(flat({ ...NO_FILTER, backends: new Set(['mail']) })).toBe('b,c');
      expect(flat({ ...NO_FILTER, accounts: new Set(['mail-def456']) })).toBe('b');
      expect(flat({ ...NO_FILTER, query: ' ANN ' })).toBe('a,c');
    });

    it('offers filter chips only when there is a choice', () => {
      const one = [entry({ id: 'a' })];
      expect(backendChoices(one).length).toBe(0);
      const two = [entry({ id: 'a' }), entry({ id: 'b', backend: 'mail', accountId: 'mail-def456' })];
      expect(backendChoices(two).join(',')).toBe('mail,xmpp');
      expect(accountChoices(two, new Set()).length).toBe(0);
      expect(accountChoices(two, new Set(['mail'])).length).toBe(0);
      const mails = [...two, entry({ id: 'c', backend: 'mail', accountId: 'mail-zzz999' })];
      expect(accountChoices(mails, new Set(['mail'])).join(',')).toBe('mail-def456,mail-zzz999');
    });

    it('names protocols and falls back for an unknown backend', () => {
      expect(protocolLabel('mail')).toBe('Mail');
      expect(protocolLabel('future')).toBe('future');
      expect(protocolIcon('future').endsWith('-symbolic')).toBe(true);
    });

    it('takes initials from the first two words', () => {
      expect(initials('Anna Example')).toBe('AE');
      expect(initials('  (team) chat room')).toBe('TC');
      expect(initials('ben')).toBe('B');
      expect(initials('')).toBe('');
    });
  });
};
