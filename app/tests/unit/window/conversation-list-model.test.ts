import { describe, expect, it } from '@gjsify/unit';
import type { Conversation } from '@curlew/protocol';

import {
  type ListEntry,
  NO_FILTER,
  accountChoices,
  backendChoices,
  buildSections,
  entryTitle,
  dropDeselectedAccounts,
  initials,
  matches,
  protocolIcon,
  protocolLabel,
  shortTime,
  toEntries,
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
  conversationIds: [over.id],
  title: over.id,
  backend: 'xmpp',
  accountId: 'xmpp-abc123',
  kind: 'direct',
  unread: 0,
  lastMessageAt: null,
  target: null,
  emailChat: false,
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
    });

    it("sends to the backend's own address kind, not the participant's first address", () => {
      const person = (...addresses: Conversation['participants'][number]['addresses']) => [
        { id: 'p', displayName: null, addresses, contactUid: null },
      ];
      const phone = { kind: 'phone' as const, value: '+15550100' };
      const targetFor = (backend: string, participants: Conversation['participants']) =>
        toEntry(conversation({ id: 'a', backend, participants })).target;
      expect(targetFor('signal', person(phone, { kind: 'signal', value: 'aci-1' }))).toBe('aci-1');
      expect(targetFor('whatsapp', person(phone, { kind: 'whatsapp', value: '15550100@s.whatsapp.net' }))).toBe(
        '15550100@s.whatsapp.net',
      );
      expect(targetFor('telegram', person(phone, { kind: 'telegram', value: '42' }))).toBe('42');
      expect(targetFor('xmpp', person({ kind: 'email', value: 'a@example.invalid' }, { kind: 'jid', value: 'a@example.org' }))).toBe(
        'a@example.org',
      );
      expect(targetFor('signal', person(phone))).toBe(null);
      expect(targetFor('signal', person({ kind: 'signal', value: 'aci-1' }, { kind: 'signal', value: 'aci-2' }).concat(person(phone)))).toBe(null);
      expect(unreadTier(entry({ id: 'a', unread: 2 }))).toBe('count');
      expect(unreadTier(entry({ id: 'a' }))).toBe('none');
      expect(unreadText(7)).toBe('7');
      expect(unreadText(150)).toBe('99+');
    });

    const mailWith = (id: string, person: string, over: Partial<Conversation> = {}): Conversation =>
      conversation({
        id,
        backend: 'mail',
        accountId: 'mail-1',
        emailChat: false,
        participants: [
          {
            id: person,
            displayName: null,
            addresses: [{ kind: 'email', value: `${person}@example.invalid` }],
            contactUid: null,
          },
        ],
        ...over,
      } as Partial<Conversation> & { id: string });

    it('folds direct mail threads with one person into one row, keeping every thread id', () => {
      const list = toEntries([
        mailWith('t-1', 'anna', { unreadCount: 1, lastMessageAt: '2026-11-01T00:00:00Z' }),
        mailWith('t-2', 'anna', { unreadCount: 2, lastMessageAt: '2026-11-03T00:00:00Z', emailChat: true }),
        mailWith('t-3', 'ben'),
        conversation({ id: 'x-1' }),
      ]);
      expect(ids(list)).toStrictEqual(['mail-contact:mail-1:anna', 'mail-contact:mail-1:ben', 'x-1']);
      expect(list[0].conversationIds).toStrictEqual(['t-1', 't-2']);
      expect(list[0].unread).toBe(3);
      expect(list[0].lastMessageAt).toBe('2026-11-03T00:00:00Z');
      expect(list[0].emailChat).toBe(true);
      expect(list[0].target).toBe('anna@example.invalid');
    });

    it('hides unmarked mail threads when not showing all emails, never other backends', () => {
      const list = toEntries(
        [mailWith('t-1', 'anna'), mailWith('t-2', 'ben', { emailChat: true }), conversation({ id: 'x-1' })],
        false,
      );
      expect(ids(list)).toStrictEqual(['mail-contact:mail-1:ben', 'x-1']);
      expect(list[0].conversationIds).toStrictEqual(['t-2']);
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
      expect(flat({ ...NO_FILTER, backends: new Set(['mail']), accounts: new Map([['mail', new Set(['mail-def456'])]]) })).toBe('b');
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
      const groups = accountChoices(mails, new Set(['mail']));
      expect(groups.length).toBe(1);
      expect(groups[0].backend).toBe('mail');
      expect(groups[0].accounts.join(',')).toBe('mail-def456,mail-zzz999');
    });

    it('offers no account chips for three protocols with one account each', () => {
      const three = [
        entry({ id: 'a' }),
        entry({ id: 'b', backend: 'mail', accountId: 'mail-def456' }),
        entry({ id: 'c', backend: 'signal', accountId: 'signal-1' }),
      ];
      expect(accountChoices(three, new Set(['xmpp', 'mail', 'signal'])).length).toBe(0);
    });

    it('groups account chips under the protocol that has several', () => {
      const list = [
        entry({ id: 'a', backend: 'mail', accountId: 'mail-1' }),
        entry({ id: 'b', backend: 'mail', accountId: 'mail-2' }),
        entry({ id: 'c', backend: 'signal', accountId: 'signal-1' }),
        entry({ id: 'd', backend: 'xmpp', accountId: 'xmpp-1' }),
        entry({ id: 'e', backend: 'xmpp', accountId: 'xmpp-2' }),
      ];
      const groups = accountChoices(list, new Set(['mail', 'signal', 'xmpp']));
      expect(groups.map((g) => g.backend).join(',')).toBe('mail,xmpp');
      expect(accountChoices(list, new Set(['signal'])).length).toBe(0);
    });

    it('narrows an account choice only within its own protocol', () => {
      const list = [
        entry({ id: 'a', backend: 'mail', accountId: 'mail-1' }),
        entry({ id: 'b', backend: 'mail', accountId: 'mail-2' }),
        entry({ id: 'c', backend: 'signal', accountId: 'signal-1' }),
      ];
      const filter = {
        ...NO_FILTER,
        backends: new Set(['mail', 'signal']),
        accounts: new Map([['mail', new Set(['mail-1'])]]),
      };
      expect(list.filter((e) => matches(e, filter)).map((e) => e.id).join(',')).toBe('a,c');
    });

    it('ignores account choices of a protocol that is not chosen', () => {
      const list = [
        entry({ id: 'a', backend: 'mail', accountId: 'mail-1' }),
        entry({ id: 'b', backend: 'mail', accountId: 'mail-2' }),
        entry({ id: 'c', backend: 'signal', accountId: 'signal-1' }),
      ];
      const accounts = new Map([['mail', new Set(['mail-1'])]]);
      const stale = { ...NO_FILTER, backends: new Set(['signal']), accounts };
      expect(list.filter((e) => matches(e, stale)).map((e) => e.id).join(',')).toBe('c');
      const chosen = new Set(['signal']);
      dropDeselectedAccounts(accounts, chosen);
      expect(accounts.size).toBe(0);
      const kept = new Map([['mail', new Set(['mail-1'])], ['signal', new Set(['signal-1'])]]);
      dropDeselectedAccounts(kept, new Set(['signal']));
      expect([...kept.keys()].join(',')).toBe('signal');
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
