import { describe, expect, it } from '@gjsify/unit';

import {
  getConversation,
  listConversations,
  markReceiptSent,
  pendingReadReceipts,
  rebuildConversations,
  syncIndex,
} from '@curlew/store';
import { AT, FakeBackend, freshDb, message } from './fixtures.ts';

/** Read receipts in the index: a receipt is a tick on its target, never a row. All content is synthetic. */

const ANNA = { name: 'Anna Example', email: 'anna@example.org' };
const ME = { name: 'Me', email: 'me@example.com' };

async function indexed(extra: Parameters<typeof message>[3][]) {
  const backend = new FakeBackend();
  backend.put('INBOX', [
    message(1, 'Hallo', 'Hi', {
      messageId: '<m1@example.org>',
      from: [ANNA],
      to: [ME],
      emailChat: true,
      receiptTo: 'anna@example.org',
    }),
    message(2, 'Re: Hallo', 'Hello', {
      messageId: '<m2@example.org>',
      inReplyTo: '<m1@example.org>',
      from: [ME],
      to: [ANNA],
      emailChat: true,
    }),
    ...extra.map((e, i) =>
      message(3 + i, 'Read receipt', '', { from: [ANNA], to: [ME], emailChat: true, ...e }),
    ),
  ]);
  const db = freshDb();
  await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
  rebuildConversations(db, {});
  const id = listConversations(db, {})[0]?.id;
  return { db, id, detail: id ? getConversation(db, id, {}) : undefined };
}

export default async () => {
  await describe('read receipts in the index', async () => {
    await it('books a receipt as a tick on its target and adds no message', async () => {
      const { db, detail } = await indexed([
        { messageId: '<r1@example.org>', mdn: { for: '<m2@example.org>' } },
      ]);
      try {
        expect(detail?.messages.length).toBe(2);
        const own = detail?.messages.find((m) => m.fromSelf);
        expect(own?.readByPeer).toBe(true);
      } finally {
        db.close();
      }
    });

    await it('shows no tick without a receipt, nor for a receipt that we sent ourselves', async () => {
      const none = await indexed([]);
      const mine = await indexed([
        { messageId: '<r1@example.org>', from: [ME], mdn: { for: '<m2@example.org>' } },
      ]);
      try {
        expect(none.detail?.messages.find((m) => m.fromSelf)?.readByPeer).toBe(false);
        expect(mine.detail?.messages.find((m) => m.fromSelf)?.readByPeer).toBe(false);
        expect(mine.detail?.messages.length).toBe(2);
      } finally {
        none.db.close();
        mine.db.close();
      }
    });

    await it('creates no list row for a receipt that opens no conversation of its own', async () => {
      const { db } = await indexed([{ messageId: '<r1@example.org>', mdn: { for: '<gone@example.org>' } }]);
      try {
        expect(listConversations(db, {}).length).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  await describe('pending read receipts', async () => {
    await it('lists an unseen Delta Chat message that asked for one, and not again once sent', async () => {
      const { db, id } = await indexed([]);
      try {
        expect(pendingReadReceipts(db, id!)).toStrictEqual([
          { accountId: 'acct', to: 'anna@example.org', messageId: '<m1@example.org>' },
        ]);
        markReceiptSent(db, 'acct', '<m1@example.org>');
        expect(pendingReadReceipts(db, id!)).toStrictEqual([]);
      } finally {
        db.close();
      }
    });

    await it('ignores a message that did not ask, one already seen, and an address that is not the sender', async () => {
      const backend = new FakeBackend();
      backend.put('INBOX', [
        message(1, 'a', 'x', { messageId: '<a@example.org>', from: [ANNA], emailChat: true }),
        message(2, 'b', 'x', {
          messageId: '<b@example.org>',
          from: [ANNA],
          emailChat: true,
          receiptTo: 'anna@example.org',
          seen: true,
        }),
        message(3, 'c', 'x', {
          messageId: '<c@example.org>',
          from: [ANNA],
          emailChat: true,
          receiptTo: 'someone-else@example.org',
        }),
        message(4, 'd', 'x', {
          messageId: '<d@example.org>',
          from: [ANNA],
          emailChat: false,
          receiptTo: 'anna@example.org',
        }),
      ]);
      const db = freshDb();
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        rebuildConversations(db, {});
        const ids = (db.prepare('SELECT id FROM conversations').all() as Array<{ id: string }>).map(
          (c) => c.id,
        );
        expect(ids.length).toBe(4);
        const all = ids.flatMap((id) => pendingReadReceipts(db, id));
        expect(all).toStrictEqual([]);
      } finally {
        db.close();
      }
    });
  });
};
