import { describe, expect, it } from '@gjsify/unit';

import type { AutomationHeaders, ContactDTO } from '@curlew/protocol';
import {
  getConversation,
  getMessagesByRemoteId,
  getRecentMessages,
  latestMessagePreviews,
  deleteOwnMessage,
  listConversations,
  mailAttachments,
  mailReplyTarget,
  migrate,
  openIndexDb,
  participantIdsOfTarget,
  rebuildConversations,
  SCHEMA_VERSION,
  searchMessageText,
  setMessageText,
  syncIndex,
} from '@curlew/store';
import { AT, FakeBackend, folder, freshDb, message } from './fixtures.ts';

/**
 * Conversations built from a synced fake mailbox: threading, participants, the
 * conversational/automated split, overrides at read time, and the privacy default of no bodies.
 * The account identity in the fake is `me@example.com`, which makes it the user's own address.
 * All content is synthetic.
 */

const NONE: AutomationHeaders = {
  listId: null,
  listUnsubscribe: null,
  autoSubmitted: null,
  precedence: null,
};
const ANNA = { name: 'Anna Example', email: 'Anna@example.org' };
const BEN = { name: 'Ben Example', email: 'ben@example.net' };
const ME = { name: 'Me', email: 'me@example.com' };
const SHOP = { name: 'Shop', email: 'news@shop.example' };

const CONTACTS: ContactDTO[] = [
  {
    uid: 'contact-anna',
    name: 'Anna E.',
    org: null,
    emails: ['anna@example.org', 'anna@work.example'],
    phones: ['+49 151 0000000'],
  },
];

/** A mailbox with: a thread Anna ↔ me, a newsletter, a stranger, and a thread I started to Ben. */
function mailbox(): FakeBackend {
  const backend = new FakeBackend();
  backend.put('INBOX', [
    message(1, 'Sommerfest', 'Kommst du am Samstag?', {
      messageId: '<t1@example.org>',
      from: [ANNA],
      to: [ME],
    }),
    message(2, 'Re: Sommerfest', 'Ja, gerne', {
      messageId: '<t2@example.com>',
      from: [ME],
      to: [ANNA],
      inReplyTo: '<t1@example.org>',
      references: ['<t1@example.org>'],
      seen: true,
    }),
    message(3, 'Newsletter Mai', 'Angebote', {
      messageId: '<n1@shop.example>',
      from: [SHOP],
      to: [ME],
      automation: { ...NONE, listUnsubscribe: '<mailto:unsub@shop.example>' },
    }),
    message(4, 'Frage zum Angebot', 'Hallo, eine Frage', {
      messageId: '<s1@example.net>',
      from: [BEN],
      to: [ME],
    }),
    message(5, 'Treffen', 'Hallo Ben und Anna', {
      messageId: '<m1@example.com>',
      from: [ME],
      to: [BEN],
      cc: [ANNA],
      seen: true,
    }),
  ]);
  return backend;
}

async function built() {
  const db = freshDb();
  await syncIndex(db, mailbox(), { now: AT('2026-08-06T12:00:00Z') });
  const result = rebuildConversations(db, { contacts: CONTACTS });
  return { db, result };
}

export default async () => {
  await describe('rebuildConversations', async () => {
    await it('threads the mailbox into conversations', async () => {
      const { db, result } = await built();
      try {
        expect(result.conversations).toBe(4);
        expect(result.messages).toBe(5);
        const all = listConversations(db);
        expect(all.length).toBe(4);
        const fest = all.find((c) => c.title === 'Sommerfest');
        expect(fest?.messageCount).toBe(2);
        expect(fest?.backend).toBe('mail');
      } finally {
        db.close();
      }
    });

    await it('builds one participant per person, with every address the contact has', async () => {
      const { db } = await built();
      try {
        const fest = listConversations(db).find((c) => c.title === 'Sommerfest');
        expect(fest?.participants.length).toBe(1);
        const anna = fest?.participants[0];
        expect(anna?.contactUid).toBe('contact-anna');
        expect(anna?.displayName).toBe('Anna E.');
        // Mail, a second mail address and a phone — one person, three typed addresses.
        expect(anna?.addresses.map((a) => `${a.kind}:${a.value}`).sort()).toEqualArray([
          'email:anna@example.org',
          'email:anna@work.example',
          'phone:+491510000000',
        ]);
      } finally {
        db.close();
      }
    });

    await it('never lists the user among the participants, and marks group threads', async () => {
      const { db } = await built();
      try {
        const meeting = listConversations(db).find((c) => c.title === 'Treffen');
        expect(meeting?.kind).toBe('group');
        expect(meeting?.participants.length).toBe(2);
        const addresses = meeting?.participants.flatMap((p) => p.addresses.map((a) => a.value)) ?? [];
        expect(addresses.includes('me@example.com')).toBe(false);
      } finally {
        db.close();
      }
    });

    await it('classifies: replied and own threads are people, the newsletter and the stranger are not', async () => {
      const { db } = await built();
      try {
        const byTitle = new Map(listConversations(db).map((c) => [c.title, c]));
        expect(byTitle.get('Sommerfest')?.classification).toBe('conversational');
        expect(byTitle.get('Treffen')?.classification).toBe('conversational');
        expect(byTitle.get('Newsletter Mai')?.classificationReason).toBe('automated-header');
        expect(byTitle.get('Frage zum Angebot')?.classificationReason).toBe('unknown-sender');

        const people = listConversations(db, { peopleOnly: true })
          .map((c) => c.title)
          .sort();
        expect(people).toEqualArray(['Sommerfest', 'Treffen']);
      } finally {
        db.close();
      }
    });

    await it('counts unread messages from others only', async () => {
      const { db } = await built();
      try {
        const fest = listConversations(db).find((c) => c.title === 'Sommerfest');
        expect(fest?.unreadCount).toBe(1);
      } finally {
        db.close();
      }
    });

    await it('is idempotent: a second rebuild yields the same ids', async () => {
      const { db } = await built();
      try {
        const before = listConversations(db)
          .map((c) => c.id)
          .sort();
        rebuildConversations(db, { contacts: CONTACTS });
        const after = listConversations(db)
          .map((c) => c.id)
          .sort();
        expect(after).toEqualArray(before);
      } finally {
        db.close();
      }
    });

    await it('without an address book, a contact is just an address', async () => {
      const { db } = await built();
      try {
        rebuildConversations(db, {});
        const fest = listConversations(db).find((c) => c.title === 'Sommerfest');
        // Still conversational — the user replied — but no longer linked to a contact.
        expect(fest?.classification).toBe('conversational');
        expect(fest?.participants[0]?.contactUid).toBe(null);
        expect(fest?.participants[0]?.addresses.length).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  await describe('reaction mails', async () => {
    const chatMailbox = (reactions: Parameters<typeof message>[3][]): FakeBackend => {
      const backend = new FakeBackend();
      backend.put('INBOX', [
        message(1, 'Hallo', 'Hi', { messageId: '<t1@example.org>', from: [ANNA], to: [ME], emailChat: true }),
        ...reactions.map((extra, i) =>
          message(2 + i, 'Message', '', { from: [ANNA], to: [ME], emailChat: true, ...extra }),
        ),
      ]);
      return backend;
    };
    const shown = async (reactions: Parameters<typeof message>[3][]) => {
      const db = freshDb();
      await syncIndex(db, chatMailbox(reactions), { now: AT('2026-08-06T12:00:00Z') });
      rebuildConversations(db, {});
      const list = listConversations(db, {});
      const id = list[0]?.id;
      return {
        list,
        detail: id ? getConversation(db, id, {}) : undefined,
        full: id ? getConversation(db, id, { includeBodies: true }) : undefined,
      };
    };

    await it('attaches the emoji to its target and adds no message', async () => {
      const { list, detail } = await shown([
        { messageId: '<r1@example.org>', inReplyTo: '<t1@example.org>', reaction: true, bodyText: '👍' },
      ]);
      expect(list.length).toBe(1);
      expect(detail?.messages.length).toBe(1);
      expect(detail?.messages[0].reactions?.[0].emoji).toBe('👍');
    });

    await it('lets the latest reaction of a person replace the earlier one, and an empty one take it back', async () => {
      const first = {
        messageId: '<r1@example.org>',
        inReplyTo: '<t1@example.org>',
        reaction: true,
        bodyText: '👍',
      };
      const replaced = await shown([first, { ...first, messageId: '<r2@example.org>', bodyText: '❤️' }]);
      expect(replaced.detail?.messages[0].reactions?.map((r) => r.emoji)).toStrictEqual(['❤️']);
      const taken = await shown([first, { ...first, messageId: '<r2@example.org>', bodyText: '' }]);
      expect(taken.detail?.messages[0].reactions).toBe(undefined);
    });

    await it('replaces the text on a Chat-Edit, skipping the quote and the pencil, and shows no extra message', async () => {
      const {
        list,
        detail,
        full: withBody,
      } = await shown([
        {
          messageId: '<e1@example.org>',
          inReplyTo: '<t1@example.org>',
          chatEdit: '<t1@example.org>',
          bodyText: 'On 2026-01-01, Anna wrote:\n> Hi\n\n✏️Hi there',
        },
      ]);
      expect(list.length).toBe(1);
      expect(detail?.messages.length).toBe(1);
      expect(withBody?.messages[0].bodyText).toBe('Hi there');
      expect(withBody?.messages[0].editedAt !== undefined).toBe(true);
    });

    await it('removes the message on a Chat-Delete, and ignores a request from someone else or for an unknown id', async () => {
      const gone = await shown([
        {
          messageId: '<d1@example.org>',
          inReplyTo: '<t1@example.org>',
          chatDelete: '<t1@example.org>',
          bodyText: 'foo',
        },
      ]);
      expect(gone.list.length).toBe(0);
      const foreign = await shown([
        {
          messageId: '<d1@example.org>',
          inReplyTo: '<t1@example.org>',
          chatDelete: '<t1@example.org>',
          from: [BEN],
          bodyText: 'foo',
        },
      ]);
      expect(foreign.detail?.messages.length).toBe(1);
      const unknown = await shown([
        {
          messageId: '<d1@example.org>',
          inReplyTo: '<t1@example.org>',
          chatDelete: '<nope@example.org>',
          bodyText: 'foo',
        },
      ]);
      expect(unknown.detail?.messages.length).toBe(1);
    });

    await it('drops a reaction whose target the index does not hold', async () => {
      const { list, detail } = await shown([
        { messageId: '<r1@example.org>', inReplyTo: '<gone@example.org>', reaction: true, bodyText: '👍' },
      ]);
      expect(list.length).toBe(1);
      expect(detail?.messages[0].reactions).toBe(undefined);
    });
  });

  await describe('own delete and edit echo', async () => {
    const mailbox = (extra: Parameters<typeof message>[3][] = []): FakeBackend => {
      const backend = new FakeBackend();
      backend.put('INBOX', [
        message(1, 'Hallo', 'Hi', { messageId: '<t1@example.org>', from: [ANNA], to: [ME], emailChat: true }),
        ...extra.map((x, i) =>
          message(2 + i, 'Message', '', { from: [ANNA], to: [ME], emailChat: true, ...x }),
        ),
      ]);
      return backend;
    };
    const open = async (backend: FakeBackend) => {
      const db = freshDb();
      await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
      rebuildConversations(db, {});
      return db;
    };
    const first = (db: ReturnType<typeof freshDb>) => {
      const id = listConversations(db, {})[0]?.id;
      return id ? getConversation(db, id, {})?.messages[0] : undefined;
    };
    const markers = (db: ReturnType<typeof freshDb>) =>
      (db.prepare("SELECT key FROM schema_meta WHERE key LIKE 'pending-delete:%'").all() as unknown[]).length;

    await it('keeps a deleted message hidden through a rebuild until its Chat-Delete mail is seen', async () => {
      const db = await open(mailbox());
      try {
        const id = first(db)?.id ?? '';
        expect(deleteOwnMessage(db, id)).toBe(true);
        rebuildConversations(db, {});
        expect(listConversations(db, {}).length).toBe(0);
        expect(markers(db)).toBe(1);
        await syncIndex(
          db,
          mailbox([
            {
              messageId: '<d1@example.org>',
              inReplyTo: '<t1@example.org>',
              chatDelete: '<t1@example.org>',
              bodyText: 'x',
            },
          ]),
          { now: AT('2026-08-06T12:00:00Z') },
        );
        rebuildConversations(db, {});
        expect(listConversations(db, {}).length).toBe(0);
        expect(markers(db)).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('keeps the text of an own edit through a rebuild', async () => {
      const db = await open(mailbox());
      try {
        const id = first(db)?.id ?? '';
        expect(setMessageText(db, id, 'Hi there')).toBe(true);
        rebuildConversations(db, {});
        const again = getConversation(db, listConversations(db, {})[0].id, { includeBodies: true });
        expect(again?.messages[0].bodyText).toBe('Hi there');
        expect(again?.messages[0].editedAt !== undefined).toBe(true);
      } finally {
        db.close();
      }
    });
  });

  await describe('bulk writes', async () => {
    await it('writes every row across several multi-row INSERT chunks', async () => {
      // 121 threads: many chunks at every table's width, plus a short tail. A `?` in the data
      // proves the values are bound, not spliced into the SQL text.
      // Seeded straight into `messages`: through syncIndex the upserts alone took seconds on GJS.
      const db = freshDb();
      try {
        const from = JSON.stringify([BEN]);
        const to = JSON.stringify([ME]);
        // The account identity is what makes me@example.com the user, not a participant.
        db.prepare('INSERT INTO accounts (id, identity, provider) VALUES (?, ?, ?)').run(
          'acct',
          'me@example.com',
          'imap_smtp',
        );
        for (let start = 0; start < 121; start += 11) {
          const rows = Array.from({ length: 11 }, (_, k) => start + k);
          db.prepare(
            `INSERT INTO messages (account_id, folder_path, uid, message_id, subject, sender, recipients, date,
               indexed_at, thread_refs, from_json, to_json)
             VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          ).run(
            ...rows.flatMap((i) => [
              'acct',
              'INBOX',
              i + 1,
              `<bulk${i}@example.org>`,
              `Frage ${i}?`,
              'Ben',
              'me@example.com',
              '2026-08-06T10:00:00Z',
              '2026-08-06T12:00:00Z',
              '',
              from,
              to,
            ]),
          );
        }
        const result = rebuildConversations(db, {});
        const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
        expect(result.conversations).toBe(121);
        expect(count('SELECT COUNT(*) AS n FROM conversations')).toBe(121);
        expect(count('SELECT COUNT(*) AS n FROM conversation_messages')).toBe(121);
        expect(count('SELECT COUNT(*) AS n FROM conversation_participants')).toBe(121);
        expect(count(`SELECT COUNT(*) AS n FROM conversations WHERE title = 'Frage 120?'`)).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  await describe('per-sender overrides at read time', async () => {
    await it('promote a stranger into the people list', async () => {
      const { db } = await built();
      try {
        const overrides = { 'ben@example.net': 'conversational' as const };
        const people = listConversations(db, { peopleOnly: true, overrides });
        const question = people.find((c) => c.title === 'Frage zum Angebot');
        expect(question?.classification).toBe('conversational');
        expect(question?.classificationReason).toBe('override');
      } finally {
        db.close();
      }
    });

    await it('demote a sender out of it, even in a thread the user replied in', async () => {
      const { db } = await built();
      try {
        const overrides = { 'anna@example.org': 'automated' as const };
        const people = listConversations(db, { peopleOnly: true, overrides }).map((c) => c.title);
        expect(people.includes('Sommerfest')).toBe(false);
        // The SQL filter and the JS verdict must agree: what the filter drops is automated.
        const fest = listConversations(db, { overrides }).find((c) => c.title === 'Sommerfest');
        expect(fest?.classification).toBe('automated');
      } finally {
        db.close();
      }
    });
  });

  await describe('getConversation', async () => {
    await it('returns messages oldest first, as documents, with a ref mail_get_message accepts', async () => {
      const { db } = await built();
      try {
        const id = listConversations(db).find((c) => c.title === 'Sommerfest')?.id ?? '';
        const found = getConversation(db, id);
        expect(found?.messages.length).toBe(2);
        const [first, second] = found?.messages ?? [];
        expect(first.presentation).toBe('document');
        expect(first.fromSelf).toBe(false);
        expect(first.senderAddress?.value).toBe('anna@example.org');
        expect(second.fromSelf).toBe(true);
        expect(second.senderId).toBe(null);
        expect(first.ref.folder).toBe('INBOX');
        expect(first.ref.uid).toBe(1);
        // Mail is located by folder + uid; its remoteId is the Message-ID a reaction names.
        expect(first.ref.remoteId).toBe('<t1@example.org>');
      } finally {
        db.close();
      }
    });

    await it('omits bodies unless asked, and caps them when asked', async () => {
      const { db } = await built();
      try {
        const id = listConversations(db).find((c) => c.title === 'Sommerfest')?.id ?? '';
        const plain = getConversation(db, id);
        expect(plain?.messages[0].bodyText).toBe(undefined);
        const withBodies = getConversation(db, id, { includeBodies: true, maxBodyChars: 5 });
        expect(withBodies?.messages[0].bodyText).toBe('Komms');
        expect(withBodies?.messages[0].bodyTruncated).toBe(true);
      } finally {
        db.close();
      }
    });

    await it('carries the encrypted flag of a mail to its conversation message', async () => {
      const backend = new FakeBackend();
      backend.put('INBOX', [
        message(1, '...', '', {
          messageId: '<e1@example.org>',
          from: [ANNA],
          to: [ME],
          emailChat: true,
          encrypted: true,
        }),
        message(2, 'Plain', 'Hello', { messageId: '<e2@example.org>', from: [BEN], to: [ME] }),
      ]);
      const db = freshDb();
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        rebuildConversations(db, { contacts: CONTACTS });
        const flags = listConversations(db)
          .map((c) => getConversation(db, c.id)?.messages[0])
          .map((m) => m?.encrypted === true);
        expect(flags.filter(Boolean).length).toBe(1);
        expect(flags.length).toBe(2);
      } finally {
        db.close();
      }
    });

    await it('marks a thread an email chat when any message carries Chat-Version, per message too', async () => {
      const backend = new FakeBackend();
      backend.put('INBOX', [
        message(1, 'Chat: Hallo', 'Hallo', { messageId: '<c1@example.org>', from: [ANNA], to: [ME] }),
        message(2, 'Chat: Hallo', 'Hi', {
          messageId: '<c2@example.com>',
          from: [ME],
          to: [ANNA],
          inReplyTo: '<c1@example.org>',
          references: ['<c1@example.org>'],
          emailChat: true,
        }),
        message(3, 'Rechnung', 'Anbei', { messageId: '<r1@example.net>', from: [BEN], to: [ME] }),
      ]);
      const db = freshDb();
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        rebuildConversations(db, { contacts: CONTACTS });
        const all = listConversations(db);
        const chat = all.find((c) => c.messageCount === 2);
        expect(chat?.emailChat).toBe(true);
        expect(all.find((c) => c.messageCount === 1)?.emailChat).toBe(false);
        // The window asks for email chats alone so that newsletters cannot fill its limit.
        expect(listConversations(db, { emailChat: true, limit: 1 }).map((c) => c.id)).toStrictEqual([
          chat?.id,
        ]);
        expect(listConversations(db, { excludeBackend: 'mail' }).length).toBe(0);
        const found = getConversation(db, chat?.id ?? '');
        expect(found?.messages.map((m) => m.emailChat)).toStrictEqual([false, true]);
        const target = mailReplyTarget(db, found?.messages[1].ref ?? { accountId: '', backend: 'mail' });
        expect(target?.messageId).toBe('<c2@example.com>');
        expect(target?.references).toStrictEqual(['<c1@example.org>']);
      } finally {
        db.close();
      }
    });

    await it('lists what a mail message carries, by file name and type', async () => {
      const backend = new FakeBackend();
      backend.put('INBOX', [
        message(1, 'Foto', '', {
          from: [ANNA],
          to: [ME],
          hasAttachment: true,
          attachments: [
            { section: '2', filename: 'cat.jpg', mimeType: 'image/jpeg', size: 10 },
            { section: '3', filename: null, mimeType: 'application/pdf', size: 20 },
          ],
        }),
        message(2, 'Ohne', 'Text', { from: [BEN], to: [ME] }),
      ]);
      const db = freshDb();
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        rebuildConversations(db, { contacts: CONTACTS });
        const ref = { accountId: 'fake', backend: 'mail', folder: 'INBOX', uid: 1 };
        const found = listConversations(db).flatMap((c) => getConversation(db, c.id)?.messages ?? []);
        const withFile = found.find((m) => m.hasAttachments);
        expect(
          mailAttachments(db, withFile?.ref ?? ref).map((a) => [a.section, a.filename, a.mimeType, a.size]),
        ).toStrictEqual([
          ['2', 'cat.jpg', 'image/jpeg', 10],
          ['3', null, 'application/pdf', 20],
        ]);
        expect(mailAttachments(db, found.find((m) => !m.hasAttachments)?.ref ?? ref).length).toBe(0);
        expect(mailAttachments(db, { accountId: 'fake', backend: 'mail' }).length).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('reads only the newest messages of several conversations, oldest first', async () => {
      const { db } = await built();
      try {
        const all = listConversations(db);
        const newest = getRecentMessages(
          db,
          all.map((c) => c.id),
          { limit: 2, includeBodies: true },
        );
        expect(newest.map((m) => m.bodyText)).toStrictEqual(['Hallo, eine Frage', 'Hallo Ben und Anna']);
        const fest = all.find((c) => c.title === 'Sommerfest')?.id ?? '';
        const one = getRecentMessages(db, [fest], { limit: 10, includeBodies: true });
        expect(one.map((m) => m.bodyText)).toStrictEqual(['Kommst du am Samstag?', 'Ja, gerne']);
        expect(getRecentMessages(db, [fest], { limit: 10 })[0].bodyText).toBe(undefined);
        expect(getRecentMessages(db, [], { limit: 10 }).length).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('pages back with a cursor: each message once, in order, across equal and missing timestamps', async () => {
      const db = freshDb();
      try {
        const stamps: Array<[string, string | null, string]> = [
          ['m-a', null, 'c-1'],
          ['m-b', null, 'c-2'],
          ['m-c', '2026-08-01T10:00:00Z', 'c-1'],
          ['m-d', '2026-08-01T10:00:00Z', 'c-2'],
          ['m-e', '2026-08-01T10:00:00Z', 'c-1'],
          ['m-f', '2026-08-02T10:00:00Z', 'c-2'],
          ['m-g', '2026-08-03T10:00:00Z', 'c-1'],
        ];
        for (const [id, sentAt, conversation] of stamps) {
          db.prepare(
            `INSERT INTO conversation_messages (id, conversation_id, backend, account_id, presentation,
               from_self, sent_at, seen, has_attachments, classification, classification_reason)
             VALUES (?, ?, 'mail', 'a-1', 'document', 0, ?, 1, 0, 'conversational', 'known-contact')`,
          ).run(id, conversation, sentAt);
        }
        const expected = ['m-a', 'm-b', 'm-c', 'm-d', 'm-e', 'm-f', 'm-g'];
        for (const size of [1, 2, 3, 7, 10]) {
          const seen: string[] = [];
          let before: { sentAt: string | null; id: string } | undefined;
          for (let guard = 0; guard < 20; guard++) {
            const page = getRecentMessages(db, ['c-1', 'c-2'], {
              limit: size,
              ...(before ? { before } : {}),
            });
            seen.unshift(...page.map((m) => m.id));
            if (page.length < size) break;
            before = { sentAt: page[0].sentAt, id: page[0].id };
          }
          expect(seen).toStrictEqual(expected);
        }
        const mid = getRecentMessages(db, ['c-1', 'c-2'], {
          limit: 10,
          before: { sentAt: '2026-08-01T10:00:00Z', id: 'm-d' },
        });
        expect(mid.map((m) => m.id)).toStrictEqual(['m-a', 'm-b', 'm-c']);
        const onlyOne = getRecentMessages(db, ['c-1'], { limit: 10, before: { sentAt: null, id: 'm-b' } });
        expect(onlyOne.map((m) => m.id)).toStrictEqual(['m-a']);
      } finally {
        db.close();
      }
    });

    await it('returns null for an unknown id', async () => {
      const { db } = await built();
      try {
        expect(getConversation(db, 'c-00000000000000')).toBe(null);
      } finally {
        db.close();
      }
    });
  });

  await describe('schema v2 upgrade', async () => {
    await it('adds the threading columns to a v1 index and resets the cursors for a re-fetch', async () => {
      const db = openIndexDb(':memory:');
      try {
        // A v1 index as it exists on disk: v1 tables, one synced folder, version 1 recorded.
        db.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        db.exec(
          `CREATE TABLE folders (account_id TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, role TEXT,
             uid_validity INTEGER, uid_next INTEGER, last_uid INTEGER NOT NULL DEFAULT 0, message_count INTEGER,
             sync_enabled INTEGER NOT NULL DEFAULT 1, last_sync_at TEXT, PRIMARY KEY (account_id, path))`,
        );
        db.exec(
          `CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
             folder_path TEXT NOT NULL, uid INTEGER NOT NULL, message_id TEXT, subject TEXT, sender TEXT,
             recipients TEXT, date TEXT, internal_date TEXT, size INTEGER, seen INTEGER NOT NULL DEFAULT 0,
             flagged INTEGER NOT NULL DEFAULT 0, has_attachment INTEGER NOT NULL DEFAULT 0, indexed_at TEXT NOT NULL)`,
        );
        db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')`).run();
        db.prepare(
          `INSERT INTO folders (account_id, path, name, uid_validity, uid_next, last_uid, message_count)
           VALUES ('acct', 'INBOX', 'INBOX', 1, 43, 42, 10)`,
        ).run();

        migrate(db);

        const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
          value: string;
        };
        expect(version.value).toBe(String(SCHEMA_VERSION));
        const folder = db.prepare('SELECT last_uid, uid_next, message_count FROM folders').get() as Record<
          string,
          unknown
        >;
        expect(Number(folder.last_uid)).toBe(0);
        expect(folder.uid_next).toBe(null);
        const columns = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
          (c) => c.name,
        );
        expect(columns.includes('thread_refs')).toBe(true);
        expect(columns.includes('list_unsubscribe')).toBe(true);
      } finally {
        db.close();
      }
    });

    await it('refuses an index from a newer curlew and leaves it untouched', async () => {
      const db = freshDb();
      try {
        db.prepare(`UPDATE schema_meta SET value = ? WHERE key = 'schema_version'`).run(
          String(SCHEMA_VERSION + 1),
        );
        expect(() => migrate(db)).toThrow(/only knows up to/);
        const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
          value: string;
        };
        // Writing our own, lower number here is what made the newer binary replay its upgrades.
        expect(version.value).toBe(String(SCHEMA_VERSION + 1));
      } finally {
        db.close();
      }
    });

    await it('replays the v2 upgrade safely after an old binary set the version back to 1', async () => {
      // A released v1 binary has no too-new check: it opens a v2 index and records version 1.
      // The next v2 open replays UPGRADES[2] against columns that already exist.
      const db = freshDb();
      try {
        db.prepare(`UPDATE schema_meta SET value = '1' WHERE key = 'schema_version'`).run();
        migrate(db);
        const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
          value: string;
        };
        expect(version.value).toBe(String(SCHEMA_VERSION));
      } finally {
        db.close();
      }
    });

    await it('migrating a current index again changes nothing', async () => {
      const db = freshDb();
      try {
        migrate(db);
        migrate(db);
        const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
          value: string;
        };
        expect(version.value).toBe(String(SCHEMA_VERSION));
      } finally {
        db.close();
      }
    });

    await it('resolves a send target to the participants that hold or link it', async () => {
      const db = freshDb();
      try {
        db.exec(`INSERT INTO participant_addresses (participant_id, kind, value) VALUES
          ('p-ana', 'email', 'ana@example.org'), ('p-ana', 'phone', '+10000000001'),
          ('p-bo', 'jid', 'bo@example.org')`);
        db.exec(`INSERT INTO chat_peer_links (backend, account_id, peer_id, participant_id) VALUES
          ('telegram', 'telegram-1', '1001', 'p-ana'), ('telegram', 'telegram-2', '1001', 'p-bo')`);
        expect(participantIdsOfTarget(db, 'mail', 'mail-1', 'Ana@Example.org')).toStrictEqual(['p-ana']);
        expect(participantIdsOfTarget(db, 'signal', 'signal-1', '+10000000001')).toStrictEqual(['p-ana']);
        expect(participantIdsOfTarget(db, 'telegram', 'telegram-1', '1001')).toStrictEqual(['p-ana']);
        expect(participantIdsOfTarget(db, 'telegram', 'telegram-2', '1001')).toStrictEqual(['p-bo']);
        expect(participantIdsOfTarget(db, 'telegram', 'telegram-3', '1001')).toStrictEqual([]);
        expect(participantIdsOfTarget(db, 'xmpp', 'xmpp-1', 'nobody@example.org')).toStrictEqual([]);
      } finally {
        db.close();
      }
    });
  });

  await describe('setMessageText', async () => {
    function insert(
      db: ReturnType<typeof freshDb>,
      id: string,
      remoteSeq: number | null = 1,
      body: string | null = null,
    ): void {
      db.prepare(
        `INSERT INTO conversation_messages (
           id, conversation_id, backend, account_id, presentation,
           from_self, seen, has_attachments, classification, classification_reason,
           remote_seq, body, edited_at)
         VALUES (?, ?, 'signal', 'signal-1', 'bubble',
           1, 1, 0, 'conversational', 'known-contact', ?, ?, ?)`,
      ).run(id, 'conv-1', remoteSeq, body, null);
    }

    await it('updates a chat message body and records the edit time', async () => {
      const db = freshDb();
      try {
        insert(db, 'm-1', 1, 'old');
        expect(setMessageText(db, 'm-1', 'new')).toBe(true);
        const row = db
          .prepare('SELECT body, edited_at FROM conversation_messages WHERE id = ?')
          .get('m-1') as {
          body: string | null;
          edited_at: string | null;
        };
        expect(row.body).toBe('new');
        expect(typeof row.edited_at).toBe('string');
        expect(row.edited_at!.length).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    });

    await it('returns false when the message does not exist', async () => {
      const db = freshDb();
      try {
        expect(setMessageText(db, 'missing', 'x')).toBe(false);
      } finally {
        db.close();
      }
    });

    await it('returns false for a mail-style message without remote_seq', async () => {
      const db = freshDb();
      try {
        insert(db, 'm-2', null, 'old');
        expect(setMessageText(db, 'm-2', 'new')).toBe(false);
        const row = db.prepare('SELECT body FROM conversation_messages WHERE id = ?').get('m-2') as {
          body: string | null;
        };
        expect(row.body).toBe('old');
      } finally {
        db.close();
      }
    });
  });

  await describe('latestMessagePreviews', async () => {
    function put(
      db: ReturnType<typeof freshDb>,
      id: string,
      conversation: string,
      sentAt: string,
      over: {
        body?: string | null;
        fromSelf?: number;
        subject?: string | null;
        files?: number;
        name?: string | null;
      } = {},
    ): void {
      db.prepare(
        `INSERT INTO conversation_messages (
           id, conversation_id, backend, account_id, presentation, sender_name,
           from_self, sent_at, subject, seen, has_attachments, classification, classification_reason, body)
         VALUES (?, ?, 'signal', 'signal-1', 'bubble', ?, ?, ?, ?, 1, ?, 'conversational', 'known-contact', ?)`,
      ).run(
        id,
        conversation,
        over.name ?? null,
        over.fromSelf ?? 0,
        sentAt,
        over.subject ?? null,
        over.files ?? 0,
        over.body ?? null,
      );
    }

    await it('returns the newest message of each conversation and skips empty ones', async () => {
      const db = freshDb();
      try {
        put(db, 'a1', 'c1', '2026-01-01T10:00:00Z', { body: 'older' });
        put(db, 'a2', 'c1', '2026-01-02T10:00:00Z', { body: 'newer', fromSelf: 1 });
        put(db, 'b1', 'c2', '2026-01-01T09:00:00Z', { body: 'hi', name: 'Bo' });
        const found = latestMessagePreviews(db, ['c1', 'c2', 'c3']);
        expect([...found.keys()].sort()).toStrictEqual(['c1', 'c2']);
        expect(found.get('c1')?.body).toBe('newer');
        expect(found.get('c1')?.fromSelf).toBe(true);
        expect(found.get('c2')?.senderName).toBe('Bo');
        expect(found.get('c2')?.fromSelf).toBe(false);
      } finally {
        db.close();
      }
    });

    await it('cuts a long body in SQL and carries subject and attachment flag', async () => {
      const db = freshDb();
      try {
        put(db, 'a1', 'c1', '2026-01-01T10:00:00Z', {
          body: 'x'.repeat(1000),
          subject: 'Re: Plan',
          files: 1,
        });
        const preview = latestMessagePreviews(db, ['c1']).get('c1')!;
        expect(preview.body?.length).toBe(300);
        expect(preview.subject).toBe('Re: Plan');
        expect(preview.hasAttachments).toBe(true);
        expect(latestMessagePreviews(db, [])).toStrictEqual(new Map());
      } finally {
        db.close();
      }
    });
  });

  await describe('searchMessageText', async () => {
    function put(
      db: ReturnType<typeof freshDb>,
      id: string,
      conversation: string,
      sentAt: string,
      body: string | null,
      subject: string | null = null,
    ): void {
      db.prepare(
        `INSERT INTO conversation_messages (
           id, conversation_id, backend, account_id, presentation,
           from_self, sent_at, subject, seen, has_attachments, classification, classification_reason, body)
         VALUES (?, ?, 'signal', 'signal-1', 'bubble', 0, ?, ?, 1, 0, 'conversational', 'known-contact', ?)`,
      ).run(id, conversation, sentAt, subject, body);
    }

    await it('finds the newest matching message per conversation, case-insensitively', async () => {
      const db = freshDb();
      try {
        put(db, 'a1', 'c1', '2026-01-01T10:00:00Z', 'Meet at the Station');
        put(db, 'a2', 'c1', '2026-01-02T10:00:00Z', 'the station again');
        put(db, 'b1', 'c2', '2026-01-03T10:00:00Z', 'nothing here');
        put(db, 'd1', 'c3', '2026-01-04T10:00:00Z', null, 'Train STATION times');
        const hits = searchMessageText(db, 'station');
        expect(hits.map((h) => h.conversationId)).toStrictEqual(['c3', 'c1']);
        expect(hits[1]?.snippet).toBe('the station again');
        expect(hits[0]?.snippet).toBe('Train STATION times');
      } finally {
        db.close();
      }
    });

    await it('cuts a snippet around the match and treats % and _ literally', async () => {
      const db = freshDb();
      try {
        put(db, 'a1', 'c1', '2026-01-01T10:00:00Z', `${'x'.repeat(200)} needle ${'y'.repeat(200)}`);
        put(db, 'a2', 'c2', '2026-01-01T11:00:00Z', 'discount of 50% today');
        const [hit] = searchMessageText(db, 'needle');
        expect(hit?.snippet.includes('needle')).toBe(true);
        expect(hit?.snippet.length).toBeLessThanOrEqual(150);
        expect(searchMessageText(db, '50%').map((h) => h.conversationId)).toStrictEqual(['c2']);
        expect(searchMessageText(db, '5_%')).toStrictEqual([]);
        expect(searchMessageText(db, '  ')).toStrictEqual([]);
      } finally {
        db.close();
      }
    });
  });

  await describe('searchMessageText in unsent drafts', async () => {
    await it('finds the body of a draft, and only a draft', async () => {
      const backend = new FakeBackend();
      backend.folders = [folder('INBOX', 'INBOX', 'inbox'), folder('Drafts', 'Drafts', 'drafts')];
      backend.put('INBOX', [
        message(1, 'Hello', 'zebra crossing ahead', {
          from: [ANNA],
          to: [ME],
          messageId: '<i1@example.org>',
        }),
      ]);
      backend.put('Drafts', [
        message(2, 'Unsent', 'my unfinished giraffe note', {
          from: [ME],
          to: [BEN],
          messageId: '<d1@example.com>',
          seen: true,
        }),
      ]);
      const db = freshDb();
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        rebuildConversations(db, { contacts: CONTACTS });
        const hits = searchMessageText(db, 'giraffe');
        expect(hits.length).toBe(1);
        expect(hits[0]?.snippet.includes('giraffe')).toBe(true);
        expect(searchMessageText(db, 'zebra').length).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  await describe('getMessagesByRemoteId', async () => {
    function put(
      db: ReturnType<typeof freshDb>,
      id: string,
      conversation: string,
      remoteId: string,
      seq: number | null,
    ): void {
      db.prepare(
        `INSERT INTO conversation_messages (
           id, conversation_id, backend, account_id, presentation,
           from_self, sent_at, seen, has_attachments, classification, classification_reason,
           remote_id, remote_seq, body)
         VALUES (?, ?, 'signal', 'signal-1', 'bubble', 0, '2026-01-01T10:00:00Z', 1, 0, 'conversational', 'known-contact', ?, ?, ?)`,
      ).run(id, conversation, remoteId, seq, `text of ${id}`);
    }

    await it('finds chat messages by network id inside the given conversations only', async () => {
      const db = freshDb();
      try {
        put(db, 'm1', 'c1', 'r1', 1);
        put(db, 'm2', 'c1', 'r2', 2);
        put(db, 'm3', 'c2', 'r1', 1);
        put(db, 'm4', 'c1', 'r3', null);
        const found = getMessagesByRemoteId(db, ['c1'], ['r1', 'r3', 'nope'], { includeBodies: true });
        expect(found.map((m) => m.id)).toStrictEqual(['m1']);
        expect(found[0]?.bodyText).toBe('text of m1');
        expect(getMessagesByRemoteId(db, [], ['r1'])).toStrictEqual([]);
        expect(getMessagesByRemoteId(db, ['c1'], [])).toStrictEqual([]);
      } finally {
        db.close();
      }
    });
  });
};
