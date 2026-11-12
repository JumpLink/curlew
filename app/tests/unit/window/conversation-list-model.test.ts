import { describe, expect, it } from '@gjsify/unit';
import type { Conversation } from '@curlew/protocol';

import {
  type ListEntry,
  type ListFilter,
  MIN_TEXT_QUERY,
  NO_FILTER,
  accountChoices,
  canSend,
  composerBlock,
  dropDeselectedAccounts,
  entryProtocolSubtitle,
  initials,
  listSubtitle,
  matches,
  previewText,
  withPreviews,
  pictureSource,
  mergePeople,
  protocolChoices,
  protocolIcon,
  protocolLabel,
  routeOptions,
  roomHint,
  selfAddressOf,
  shortTime,
  singleChoice,
  targetOf,
  backendChoices,
  buildSections,
  entryTitle,
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
  room: null,
  members: [],
  personIds: [],
  manual: false,
  pin: null,
  ...over,
});

const ids = (list: ListEntry[]): string[] => list.map((e) => e.id);

export default async () => {
  describe('conversation list model', () => {
    describe('people across networks', () => {
      const person = (id: string, name: string) => ({
        id,
        displayName: name,
        addresses: [],
        contactUid: null,
      });
      const chat = (
        id: string,
        backend: string,
        accountId: string,
        personId: string,
        at: string,
        unread = 0,
      ) =>
        conversation({
          id,
          backend,
          accountId,
          lastMessageAt: at,
          unreadCount: unread,
          participants: [person(personId, 'Ana Example')],
        });

      it('merges the chats of one participant into one row, newest member first', () => {
        const list = toEntries([
          chat('c1', 'telegram', 'telegram-1', 'p-ana', '2026-01-01T10:00:00Z', 1),
          chat('c2', 'signal', 'signal-9', 'p-ana', '2026-01-02T10:00:00Z', 2),
          chat('c3', 'signal', 'signal-9', 'p-bo', '2026-01-03T10:00:00Z'),
        ]);
        expect(list.length).toBe(2);
        const merged = list.find((e) => e.id === 'person:p-ana')!;
        expect(merged.backend).toBe('signal');
        expect(merged.unread).toBe(3);
        expect(merged.conversationIds).toStrictEqual(['c1', 'c2']);
        expect(merged.members.length).toBe(2);
        expect(merged.manual).toBe(false);
        expect(merged.personIds).toStrictEqual(['p-ana']);
      });

      it('routes a pinned row through the pinned protocol only', () => {
        const chats = [
          chat('c1', 'telegram', 'telegram-1', 'p-ana', '2026-01-01T10:00:00Z', 1),
          chat('c2', 'signal', 'signal-9', 'p-ana', '2026-01-02T10:00:00Z', 2),
        ].map((c) => ({
          ...c,
          participants: [
            { ...c.participants[0]!, addresses: [{ kind: c.backend, value: `${c.backend}-id` }] },
          ],
        })) as Conversation[];
        const auto = toEntries(chats)[0]!;
        expect(auto.pin).toBe(null);
        expect(protocolChoices(auto).length).toBe(2);
        const pinned = toEntries(chats, true, new Map(), new Map(), [], { 'p-ana': 'telegram' })[0]!;
        expect(pinned.pin).toBe('telegram');
        expect(pinned.backend).toBe('telegram');
        expect(pinned.lastMessageAt).toBe('2026-01-02T10:00:00Z');
        expect(protocolChoices(pinned).map((c) => c.backend)).toStrictEqual(['telegram']);
        expect(singleChoice(pinned)?.backend).toBe('telegram');
        expect(canSend(pinned)).toBe(true);
        expect(entryProtocolSubtitle(pinned)).toBe('Only via Telegram');
      });

      it('lets the smallest id win a pin conflict and ignores a pin on a single chat', () => {
        const list = mergePeople(
          [
            entry({ id: 'a', personIds: ['p-b'], backend: 'signal', lastMessageAt: '2026-01-01T00:00:00Z' }),
            entry({ id: 'b', personIds: ['p-a'], backend: 'xmpp', lastMessageAt: '2026-01-02T00:00:00Z' }),
            entry({ id: 'c', personIds: ['p-z'], backend: 'xmpp' }),
          ],
          [['p-a', 'p-b']],
          { 'p-a': 'xmpp', 'p-b': 'signal', 'p-z': 'signal' },
        );
        expect(list.find((e) => e.id === 'person:p-a')!.pin).toBe('xmpp');
        expect(list.find((e) => e.id === 'c')!.pin).toBe(null);
      });

      it('says why a pinned row without an address cannot send', () => {
        const pinned = entry({
          id: 'person:p-a',
          pin: 'signal',
          members: [
            entry({ id: 'x', backend: 'telegram', target: 'u1' }),
            entry({ id: 'y', backend: 'xmpp' }),
          ],
        });
        expect(protocolChoices(pinned)).toStrictEqual([]);
        expect(singleChoice(pinned)).toBe(null);
        expect(canSend(pinned)).toBe(true);
        expect(composerBlock(pinned)).toBe('Only via Signal, which has no address for this person');
      });

      it('offers automatic and each addressable protocol in the route menu', () => {
        const row = entry({
          id: 'person:p-a',
          personIds: ['p-a'],
          members: [
            entry({ id: 'x', backend: 'telegram', target: 'u1' }),
            entry({ id: 'y', backend: 'signal', target: '+10000000001' }),
            entry({ id: 'z', backend: 'mail' }),
          ],
        });
        const open = routeOptions(row);
        expect(open.map((o) => o.backend)).toStrictEqual([null, 'signal', 'telegram']);
        expect(open.map((o) => o.active)).toStrictEqual([true, false, false]);
        expect(routeOptions({ ...row, pin: 'telegram' }).map((o) => o.active)).toStrictEqual([
          false,
          false,
          true,
        ]);
        expect(routeOptions({ ...row, pin: 'mail' }).map((o) => o.backend)).toContain('mail');
        expect(routeOptions({ ...row, members: [], personIds: [] })).toStrictEqual([]);
        expect(routeOptions({ ...row, personIds: [] })).toStrictEqual([]);
      });

      it('leaves one chat alone and never merges a group or the note to self', () => {
        const list = toEntries([
          chat('c1', 'telegram', 'telegram-1', 'p-ana', '2026-01-01T10:00:00Z'),
          conversation({
            id: 'g1',
            kind: 'group',
            participants: [person('p-ana', 'Ana Example'), person('p-bo', 'Bo')],
          }),
        ]);
        expect(ids(list).sort()).toStrictEqual(['c1', 'g1']);
        expect(list.find((e) => e.id === 'g1')!.personIds).toStrictEqual([]);
      });

      it('joins two participants the person merged by hand, in either order', () => {
        const chats = [
          chat('c1', 'telegram', 'telegram-1', 'p-ana', '2026-01-01T10:00:00Z'),
          chat('c2', 'xmpp', 'xmpp-1', 'p-anna', '2026-01-02T10:00:00Z'),
        ];
        for (const merges of [[['p-ana', 'p-anna']], [['p-anna', 'p-ana']]]) {
          const list = toEntries(chats, true, new Map(), new Map(), merges);
          expect(list.length).toBe(1);
          expect(list[0]!.id).toBe('person:p-ana');
          expect(list[0]!.manual).toBe(true);
          expect(list[0]!.personIds).toStrictEqual(['p-ana', 'p-anna']);
        }
      });

      it('ignores a merge naming people that are not in the list', () => {
        const list = toEntries(
          [chat('c1', 'telegram', 'telegram-1', 'p-ana', '2026-01-01T10:00:00Z')],
          true,
          new Map(),
          new Map(),
          [['p-ana', 'p-gone']],
        );
        expect(list.length).toBe(1);
        expect(list[0]!.manual).toBe(false);
      });

      it('chains merges through a shared person', () => {
        const list = mergePeople(
          [
            entry({ id: 'a', personIds: ['p1'], lastMessageAt: '2026-01-01T00:00:00Z' }),
            entry({ id: 'b', personIds: ['p2'], lastMessageAt: '2026-01-02T00:00:00Z' }),
            entry({ id: 'c', personIds: ['p3'], lastMessageAt: '2026-01-03T00:00:00Z' }),
          ],
          [
            ['p1', 'p2'],
            ['p2', 'p3'],
          ],
        );
        expect(list.length).toBe(1);
        expect(list[0]!.conversationIds).toStrictEqual(['a', 'b', 'c']);
      });

      it('keeps a merged row while one of its carriers passes the protocol filter', () => {
        const [merged] = toEntries([
          chat('c1', 'telegram', 'telegram-1', 'p-ana', '2026-01-02T10:00:00Z'),
          chat('c2', 'signal', 'signal-9', 'p-ana', '2026-01-01T10:00:00Z'),
        ]);
        const only = (backend: string) => ({ ...NO_FILTER, backends: new Set([backend]) });
        expect(matches(merged!, only('signal'))).toBe(true);
        expect(matches(merged!, only('telegram'))).toBe(true);
        expect(matches(merged!, only('matrix'))).toBe(false);
        expect(backendChoices([merged!])).toStrictEqual(['signal', 'telegram']);
      });
    });

    describe('how a contact looks', () => {
      const chat = (id: string, backend: string, name: string, at: string) =>
        conversation({
          id,
          backend,
          accountId: `${backend}-1`,
          lastMessageAt: at,
          participants: [
            {
              id: 'p-ana',
              displayName: name,
              addresses: [{ kind: backend === 'telegram' ? 'telegram' : 'signal', value: `${id}-addr` }],
              contactUid: null,
            },
          ],
        });
      const rows = () => [
        chat('c1', 'telegram', 'Ana E.', '2026-01-02T10:00:00Z'),
        chat('c2', 'signal', 'Ana Example', '2026-01-01T10:00:00Z'),
      ];
      const can = () => true;

      it('shows the name and picture of the part the person chose', () => {
        const [plain] = toEntries(rows());
        expect(plain!.title).toBe('Ana E.');
        expect(plain!.picture).toBeUndefined();
        const [row] = toEntries(
          rows(),
          true,
          new Map(),
          new Map(),
          [],
          {},
          { 'p-ana': { name: 'c2', picture: 'c2' } },
        );
        expect(row!.title).toBe('Ana Example');
        expect(row!.picture).toStrictEqual({ from: 'c2' });
        expect(pictureSource(row!, can)).toStrictEqual({
          kind: 'chat',
          entry: row!.members.find((m) => m.id === 'c2'),
        });
      });

      it('lets an own picture beat a chosen part, and ignores a part that is gone', () => {
        const [own] = toEntries(
          rows(),
          true,
          new Map(),
          new Map(),
          [],
          {},
          {
            'p-ana': { picture: 'c2', own: 'x.png' },
          },
        );
        expect(pictureSource(own!, can)).toStrictEqual({ kind: 'own', file: 'x.png' });
        const [gone] = toEntries(
          rows(),
          true,
          new Map(),
          new Map(),
          [],
          {},
          {
            'p-ana': { name: 'c9', picture: 'c9' },
          },
        );
        expect(gone!.title).toBe('Ana E.');
        expect(gone!.picture).toBeUndefined();
      });

      it('gives a single contact an own picture too', () => {
        const [single] = toEntries(
          [rows()[0]!],
          true,
          new Map(),
          new Map(),
          [],
          {},
          {
            'p-ana': { own: 'y.png' },
          },
        );
        expect(single!.members).toStrictEqual([]);
        expect(pictureSource(single!, can)).toStrictEqual({ kind: 'own', file: 'y.png' });
      });

      it('defaults to the newest part whose network can serve a picture', () => {
        const [row] = toEntries(rows());
        expect(pictureSource(row!, can)).toMatchObject({ kind: 'chat', entry: { id: 'c1' } });
        expect(pictureSource(row!, (b) => b === 'signal')).toMatchObject({
          kind: 'chat',
          entry: { id: 'c2' },
        });
        expect(pictureSource(row!, () => false)).toBeNull();
      });
    });

    it('has a distinct badge icon per protocol', () => {
      const icons = ['mail', 'xmpp', 'signal', 'matrix', 'telegram', 'whatsapp'].map(protocolIcon);
      expect(new Set(icons).size).toBe(6);
    });

    it('targets a Matrix room by its room id, never without a room row', () => {
      const c = conversation({ id: 'm1', backend: 'matrix', kind: 'group' });
      const room = { chatId: '!r:example.org', public: true, encrypted: false, memberCount: 3 };
      expect(targetOf(c, room)).toBe('!r:example.org');
      expect(targetOf(c, null)).toBe(null);
    });

    it('blocks the composer only in a room known to be encrypted', () => {
      const room = (encrypted: boolean | null) => ({
        chatId: '!r',
        public: false,
        encrypted,
        memberCount: 2,
      });
      expect(composerBlock(entry({ id: 'a', room: room(true) }))).not.toBe(null);
      expect(composerBlock(entry({ id: 'b', room: room(false) }))).toBe(null);
      expect(composerBlock(entry({ id: 'c', room: room(null) }))).toBe(null);
      expect(composerBlock(entry({ id: 'd' }))).toBe(null);
    });

    it('hints a room as public with its members, and says nothing it does not know', () => {
      const room = (pub: boolean | null, n: number | null) => ({
        chatId: '!r',
        public: pub,
        encrypted: false,
        memberCount: n,
      });
      expect(roomHint(entry({ id: 'a', kind: 'group', room: room(true, 12) }))).toBe(
        'Public room · 12 members',
      );
      expect(roomHint(entry({ id: 'b', kind: 'group', room: room(true, 1) }))).toBe('Public room · 1 member');
      expect(roomHint(entry({ id: 'c', kind: 'group', room: room(false, 4) }))).toBe('Room · 4 members');
      expect(roomHint(entry({ id: 'd', kind: 'group', room: room(null, 4) }))).toBe(null);
      expect(roomHint(entry({ id: 'e', kind: 'group', room: room(true, null) }))).toBe(null);
      expect(roomHint(entry({ id: 'f', kind: 'direct', room: room(true, 2) }))).toBe(null);
    });

    it('finds the WhatsApp chat with oneself only when the own JID is known', () => {
      const me = conversation({
        id: 'w1',
        backend: 'whatsapp',
        accountId: 'whatsapp-x',
        participants: [
          {
            displayName: null,
            addresses: [{ kind: 'whatsapp', value: '4915100000000@s.whatsapp.net' }],
          },
        ] as unknown as Conversation['participants'],
      });
      expect(selfAddressOf(me, '4915100000000@s.whatsapp.net 123@lid')).toBe('4915100000000@s.whatsapp.net');
      expect(selfAddressOf(me, '4915199999999@s.whatsapp.net')).toBe(null);
      expect(selfAddressOf(me, undefined)).toBe(null);
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

    it('does not list opaque Signal IDs as the name of an untitled group', () => {
      const member = (id: string, displayName: string | null) => ({
        id,
        displayName,
        addresses: [{ kind: 'signal' as const, value: `${id}-aci` }],
        contactUid: null,
      });
      const group = (participants: ReturnType<typeof member>[], title: string | null = null) =>
        conversation({ id: 'g', kind: 'group', title, participants } as Partial<Conversation> & {
          id: string;
        });
      expect(entryTitle(group([member('a', null), member('b', null)]))).toBe('Unnamed group · 2 members');
      expect(entryTitle(group([member('a', null)]))).toBe('Unnamed group · 1 member');
      expect(entryTitle(group([member('a', 'Anna Example'), member('b', null)]))).toBe('Anna Example');
      expect(entryTitle(group([member('a', null)], 'Team'))).toBe('Team');
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
      expect(
        targetFor('whatsapp', person(phone, { kind: 'whatsapp', value: '15550100@s.whatsapp.net' })),
      ).toBe('15550100@s.whatsapp.net');
      expect(targetFor('telegram', person(phone, { kind: 'telegram', value: '42' }))).toBe('42');
      expect(
        targetFor(
          'xmpp',
          person({ kind: 'email', value: 'a@example.invalid' }, { kind: 'jid', value: 'a@example.org' }),
        ),
      ).toBe('a@example.org');
      expect(targetFor('signal', person(phone))).toBe(null);
      expect(
        targetFor(
          'signal',
          person({ kind: 'signal', value: 'aci-1' }, { kind: 'signal', value: 'aci-2' }).concat(
            person(phone),
          ),
        ),
      ).toBe(null);
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
      expect(
        flat({
          ...NO_FILTER,
          backends: new Set(['mail']),
          accounts: new Map([['mail', new Set(['mail-def456'])]]),
        }),
      ).toBe('b');
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
      expect(
        list
          .filter((e) => matches(e, filter))
          .map((e) => e.id)
          .join(','),
      ).toBe('a,c');
    });

    it('ignores account choices of a protocol that is not chosen', () => {
      const list = [
        entry({ id: 'a', backend: 'mail', accountId: 'mail-1' }),
        entry({ id: 'b', backend: 'mail', accountId: 'mail-2' }),
        entry({ id: 'c', backend: 'signal', accountId: 'signal-1' }),
      ];
      const accounts = new Map([['mail', new Set(['mail-1'])]]);
      const stale = { ...NO_FILTER, backends: new Set(['signal']), accounts };
      expect(
        list
          .filter((e) => matches(e, stale))
          .map((e) => e.id)
          .join(','),
      ).toBe('c');
      const chosen = new Set(['signal']);
      dropDeselectedAccounts(accounts, chosen);
      expect(accounts.size).toBe(0);
      const kept = new Map([
        ['mail', new Set(['mail-1'])],
        ['signal', new Set(['signal-1'])],
      ]);
      dropDeselectedAccounts(kept, new Set(['signal']));
      expect([...kept.keys()].join(',')).toBe('signal');
    });

    it('merges every self-chat into one row ordered by the newest message', () => {
      const selfChat = (
        id: string,
        backend: string,
        accountId: string,
        lastMessageAt: string | null,
        participants: Conversation['participants'] = [],
      ) => conversation({ id, backend, accountId, lastMessageAt, participants });
      const list = toEntries(
        [
          selfChat('x', 'xmpp', 'xmpp-me', '2026-11-01T10:00:00Z', [
            {
              id: 'p',
              displayName: null,
              addresses: [{ kind: 'jid', value: 'me@example.org' }],
              contactUid: null,
            },
          ]),
          selfChat('s', 'signal', 'signal-aci', '2026-11-02T10:00:00Z'),
          selfChat('t', 'telegram', 'telegram-42', '2026-11-01T12:00:00Z', [
            { id: 'p', displayName: null, addresses: [{ kind: 'telegram', value: '42' }], contactUid: null },
          ]),
        ],
        true,
        new Map([['xmpp-me', 'me@example.org']]),
      );
      const note = list.find((e) => e.id === 'note-to-self');
      expect(note).not.toBe(undefined);
      expect(note!.title).toBe('Note to self');
      expect(note!.self).toBe(true);
      expect(note!.backend).toBe('signal');
      expect(
        note!.members
          .map((m) => m.backend)
          .sort()
          .join(','),
      ).toBe('signal,telegram,xmpp');
      expect(note!.conversationIds).toStrictEqual(['x', 's', 't']);
    });

    it('titles and addresses the chat with oneself on every backend that can tell', () => {
      const person = (kind: 'jid' | 'matrix' | 'telegram' | 'signal', value: string) =>
        ({
          id: `p-${value}`,
          displayName: null,
          addresses: [{ kind, value }],
        }) as unknown as Conversation['participants'][number];
      const signal = conversation({ id: 's', backend: 'signal', accountId: 'signal-0a1b2c' });
      expect(toEntry(signal).title).toBe('Note to self');
      expect(toEntry(signal).target).toBe('0a1b2c');
      const other = conversation({
        id: 's2',
        backend: 'signal',
        accountId: 'signal-0a1b2c',
        participants: [person('signal', 'ffee')],
      });
      expect(toEntry(other).title).toBe('ffee');
      const group = conversation({ id: 's3', backend: 'signal', accountId: 'signal-0a1b2c', kind: 'group' });
      expect(toEntry(group).target).toBe(null);

      const tg = conversation({
        id: 't',
        backend: 'telegram',
        accountId: 'telegram-4711',
        participants: [person('telegram', '4711')],
      });
      expect(toEntry(tg).title).toBe('Note to self');
      expect(toEntry(tg).target).toBe('4711');
      const tgOther = conversation({
        id: 't2',
        backend: 'telegram',
        accountId: 'telegram-4711',
        participants: [person('telegram', '99')],
      });
      expect(toEntry(tgOther).title).toBe('99');

      const xmpp = conversation({
        id: 'x',
        accountId: 'xmpp-abc123',
        participants: [person('jid', 'Me@Example.org')],
      });
      expect(toEntry(xmpp, 'me@example.org').title).toBe('Note to self');
      expect(toEntry(xmpp, 'me@example.org').target).toBe('me@example.org');
      expect(toEntry(xmpp).title).toBe('Me@Example.org');
      expect(toEntry(xmpp, 'you@example.org').title).toBe('Me@Example.org');
      const mx = conversation({
        id: 'm',
        backend: 'matrix',
        accountId: 'matrix-1',
        participants: [person('matrix', '@me:example.org')],
      });
      expect(toEntry(mx, '@me:example.org').title).toBe('Note to self');
      // A WhatsApp or mail chat cannot be told from the index, so it stays an ordinary one.
      const wa = conversation({ id: 'w', backend: 'whatsapp', accountId: 'whatsapp-1' });
      expect(toEntry(wa, 'Me').title).toBe('Unnamed conversation');
    });

    it('knows when the composer can send and which carriers are available', () => {
      expect(canSend(entry({ id: 'a', target: 'x' }))).toBe(true);
      expect(canSend(entry({ id: 'b' }))).toBe(false);
      expect(canSend(entry({ id: 'c', members: [entry({ id: 'm1', target: 't' })] }))).toBe(true);
      expect(canSend(entry({ id: 'd', members: [entry({ id: 'm1' })] }))).toBe(false);
      const choices = protocolChoices(
        entry({ id: 'e', members: [entry({ id: 'm1', backend: 'signal', target: 'aci' })] }),
      );
      expect(choices.length).toBe(1);
      expect(choices[0]!.backend).toBe('signal');
      expect(choices[0]!.target).toBe('aci');
      const xmpp = singleChoice(entry({ id: 'f', backend: 'xmpp', target: 'a@example.org' }));
      expect(xmpp).not.toBe(null);
      expect(xmpp!.backend).toBe('xmpp');
      expect(xmpp!.target).toBe('a@example.org');
      const signal = singleChoice(
        entry({ id: 'g', members: [entry({ id: 'm1', backend: 'signal', target: 'aci' })] }),
      );
      expect(signal).not.toBe(null);
      expect(signal!.backend).toBe('signal');
      expect(signal!.target).toBe('aci');
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

    it('subtitles a merged row with every member protocol once, sorted', () => {
      const merged = entry({
        id: 'note-to-self',
        members: [
          entry({ id: 'm1', backend: 'signal', target: 'aci' }),
          entry({ id: 'm2', backend: 'xmpp', target: 'a@example.org' }),
          entry({ id: 'm3', backend: 'signal', target: 'aci' }),
        ],
      });
      expect(entryProtocolSubtitle(merged)).toBe('Signal · XMPP');
    });

    it('subtitles an ordinary row with its protocol', () => {
      expect(entryProtocolSubtitle(entry({ id: 'a', backend: 'matrix' }))).toBe('Matrix');
      expect(entryProtocolSubtitle(entry({ id: 'b', backend: 'future' }))).toBe('future');
    });

    describe('searching message text', () => {
      const rows = [
        entry({ id: 'a', title: 'Alex', conversationIds: ['c1'] }),
        entry({ id: 'b', title: 'Bo', conversationIds: ['c2', 'c3'], preview: 'newest' }),
        entry({ id: 'c', title: 'Cy', conversationIds: ['c4'] }),
      ];
      const hits = new Map([
        ['c1', '…meet at the station…'],
        ['c3', 'station is closed\n today'],
      ]);
      const search = (query: string, over: Partial<ListFilter> = {}) =>
        buildSections(rows, { ...NO_FILTER, query, hits, ...over }).flatMap((s) => s.entries);

      it('keeps rows whose messages matched even if the title does not', () => {
        expect(
          search('station')
            .map((e) => e.id)
            .sort(),
        ).toStrictEqual(['a', 'b']);
        expect(search('bo', { hits: new Map() }).map((e) => e.id)).toStrictEqual(['b']);
      });

      it('shows the matching line on the row, on one line, only while searching', () => {
        const found = search('station');
        expect(found.find((e) => e.id === 'a')?.preview).toBe('…meet at the station…');
        expect(found.find((e) => e.id === 'b')?.preview).toBe('station is closed');
        expect(search('')[0]?.preview).toBeUndefined();
        expect(rows[1]?.preview).toBe('newest');
      });

      it('still honours the protocol filter', () => {
        expect(search('station', { backends: new Set(['mail']) })).toStrictEqual([]);
      });

      it('asks for at least two characters', () => {
        expect(MIN_TEXT_QUERY).toBe(2);
      });
    });

    describe('last-message preview', () => {
      const source = (over: Partial<Parameters<typeof previewText>[0]> = {}) => ({
        sentAt: '2026-01-01T10:00:00Z',
        fromSelf: false,
        body: null,
        subject: null,
        hasAttachments: false,
        senderName: null,
        ...over,
      });

      it('shows the first non-blank line, collapsed, and cuts a long one', () => {
        expect(previewText(source({ body: '\n  Hello   there \nsecond' }), false)).toBe('Hello there');
        const cut = previewText(source({ body: 'word '.repeat(60) }), false);
        expect(cut.length).toBe(120);
        expect(cut.endsWith('…')).toBe(true);
      });

      it('falls back to the mail subject, then to an attachment note, then to nothing', () => {
        expect(previewText(source({ subject: 'Invoice' }), false)).toBe('Invoice');
        expect(previewText(source({ body: ' ', hasAttachments: true }), false)).toBe('Attachment');
        expect(previewText(source({ body: 'See file', hasAttachments: true }), false)).toBe('See file');
        expect(previewText(source(), false)).toBe('');
      });

      it('prefixes your own messages, and the sender in a group only', () => {
        expect(previewText(source({ body: 'Hi', fromSelf: true }), false)).toBe('You: Hi');
        expect(previewText(source({ body: 'Hi', fromSelf: true }), true)).toBe('You: Hi');
        expect(previewText(source({ body: 'Hi', senderName: 'Bo' }), true)).toBe('Bo: Hi');
        expect(previewText(source({ body: 'Hi', senderName: 'Bo' }), false)).toBe('Hi');
        expect(previewText(source({ body: 'Hi', senderName: ' ' }), true)).toBe('Hi');
      });

      it('picks the newest message among the conversations a row stands for', () => {
        const rows = [
          entry({ id: 'p', conversationIds: ['c1', 'c2'] }),
          entry({ id: 'q', conversationIds: ['c3'], kind: 'group' }),
          entry({ id: 'r', conversationIds: ['c4'] }),
        ];
        const found = withPreviews(
          rows,
          new Map([
            ['c1', source({ body: 'old', sentAt: '2026-01-01T10:00:00Z' })],
            ['c2', source({ body: 'new', sentAt: '2026-01-02T10:00:00Z' })],
            ['c3', source({ body: 'Hi', senderName: 'Bo' })],
          ]),
        );
        expect(found.map((e) => e.preview)).toStrictEqual(['new', 'Bo: Hi', undefined]);
        expect(rows[0]?.preview).toBeUndefined();
      });
    });

    it('lists the account label for an ordinary row, never the raw account id', () => {
      const labels = new Map([['xmpp-abc123', 'Me@example.org']]);
      expect(listSubtitle(entry({ id: 'a', backend: 'xmpp', accountId: 'xmpp-abc123' }), labels)).toBe(
        'Me@example.org',
      );
      expect(listSubtitle(entry({ id: 'b', backend: 'future', accountId: 'future-1' }), labels)).toBe(
        'future',
      );
    });

    it('lists a label per member for a merged row, falling back to the protocol', () => {
      const merged = entry({
        id: 'note-to-self',
        members: [
          entry({ id: 'm1', backend: 'signal', accountId: 'signal-1', target: 'aci' }),
          entry({ id: 'm2', backend: 'xmpp', accountId: 'xmpp-1', target: 'a@example.org' }),
          entry({ id: 'm3', backend: 'signal', accountId: 'signal-1', target: 'aci' }),
          entry({ id: 'm4', backend: 'telegram', accountId: 'telegram-1', target: '42' }),
        ],
      });
      const labels = new Map([
        ['signal-1', 'My Signal'],
        ['xmpp-1', 'Me@example.org'],
      ]);
      expect(listSubtitle(merged, labels)).toBe('Me@example.org · My Signal · Telegram');
    });
  });
};
