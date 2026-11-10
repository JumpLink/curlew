import { describe, expect, it } from '@gjsify/unit';
import type { ContactDTO } from '@curlew/protocol';

import type { ListEntry } from '../../../src/window/conversation-list-model.ts';
import {
  contactMatches,
  contactProtocols,
  contactSubtitle,
  draftEntry,
  existingEntry,
  offeredContacts,
  routeAccounts,
} from '../../../src/window/new-conversation-model.ts';

const row = (over: Partial<ListEntry> & { id: string }): ListEntry => ({
  conversationIds: [over.id],
  title: over.id,
  backend: 'xmpp',
  accountId: 'xmpp-1',
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

const contact = (over: Partial<ContactDTO> = {}): ContactDTO => ({
  uid: 'u1',
  name: 'Alex Weber',
  org: null,
  emails: [],
  phones: [],
  ...over,
});

const accounts = [
  { backend: 'mail', accountId: 'mail-1' },
  { backend: 'xmpp', accountId: 'xmpp-1' },
];

export default async () => {
  describe('new conversation model', () => {
    describe('accounts', () => {
      it('collects the xmpp and mail accounts of rows and their members, once each', () => {
        const rows = [
          row({ id: 'a', backend: 'xmpp', accountId: 'xmpp-1' }),
          row({ id: 'b', backend: 'xmpp', accountId: 'xmpp-1' }),
          row({ id: 'c', backend: 'signal', accountId: 'signal-1' }),
          row({
            id: 'p',
            backend: 'signal',
            accountId: 'signal-1',
            members: [row({ id: 'm', backend: 'mail', accountId: 'mail-1' })],
          }),
        ];
        expect(routeAccounts(rows)).toStrictEqual([
          { backend: 'xmpp', accountId: 'xmpp-1' },
          { backend: 'mail', accountId: 'mail-1' },
        ]);
      });
    });

    describe('routes', () => {
      it('offers only protocols the contact has a bare address for, most trusted first', () => {
        const c = contact({
          emails: ['alex@example.org'],
          jids: ['alex@xmpp.example.org'],
          phones: ['+4912'],
        });
        expect(contactProtocols(c, accounts)).toStrictEqual(['xmpp', 'mail']);
        expect(contactSubtitle(c, accounts)).toBe('XMPP · Mail');
        expect(contactProtocols(contact({ phones: ['+4912'] }), accounts)).toStrictEqual([]);
        expect(contactProtocols(c, [{ backend: 'mail', accountId: 'mail-1' }])).toStrictEqual(['mail']);
      });

      it('builds a draft row whose composer can pick between the routes', () => {
        const c = contact({ emails: ['alex@example.org'], jids: ['alex@xmpp.example.org'] });
        const draft = draftEntry(c, accounts)!;
        expect(draft.id).toBe('new:u1');
        expect(draft.title).toBe('Alex Weber');
        expect(draft.conversationIds).toStrictEqual([]);
        expect(draft.members.map((m) => [m.backend, m.accountId, m.target])).toStrictEqual([
          ['xmpp', 'xmpp-1', 'alex@xmpp.example.org'],
          ['mail', 'mail-1', 'alex@example.org'],
        ]);
        expect(draftEntry(contact({ phones: ['+4912'] }), accounts)).toBeNull();
      });

      it('names a contact without a name by its address', () => {
        const draft = draftEntry(contact({ name: ' ', emails: ['x@example.org'] }), accounts)!;
        expect(draft.title).toBe('x@example.org');
      });
    });

    describe('existing conversations', () => {
      it('finds the row that already writes to one of the addresses, ignoring case', () => {
        const c = contact({ emails: ['Alex@Example.org'] });
        const mail = row({ id: 'mail-row', backend: 'mail', target: 'alex@example.org' });
        const merged = row({ id: 'person', backend: 'signal', members: [mail] });
        expect(existingEntry([row({ id: 'other', target: 'bo@example.org' }), mail], c)?.id).toBe('mail-row');
        expect(existingEntry([merged], c)?.id).toBe('person');
        expect(existingEntry([row({ id: 'g', kind: 'group', target: 'alex@example.org' })], c)).toBeNull();
        expect(existingEntry([], c)).toBeNull();
      });
    });

    describe('search', () => {
      it('matches name, organisation and addresses; a blank query matches all', () => {
        const c = contact({ org: 'Studio', emails: ['alex@example.org'], jids: ['alex@xmpp.example.org'] });
        expect(contactMatches(c, '')).toBe(true);
        expect(contactMatches(c, ' weber ')).toBe(true);
        expect(contactMatches(c, 'studio')).toBe(true);
        expect(contactMatches(c, 'XMPP.EXAMPLE')).toBe(true);
        expect(contactMatches(c, 'nobody')).toBe(false);
      });

      it('offers reachable contacts by name', () => {
        const list = [
          contact({ uid: 'b', name: 'Bo', emails: ['bo@example.org'] }),
          contact({ uid: 'n', name: 'No address', phones: ['+4912'] }),
          contact({ uid: 'a', name: 'Ana', jids: ['ana@xmpp.example.org'] }),
        ];
        expect(offeredContacts(list, accounts, '').map((c) => c.uid)).toStrictEqual(['a', 'b']);
        expect(offeredContacts(list, accounts, 'bo').map((c) => c.uid)).toStrictEqual(['b']);
        expect(offeredContacts(list, [], '')).toStrictEqual([]);
      });
    });
  });
};
