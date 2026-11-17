import { describe, expect, it } from '@gjsify/unit';

import {
  chatConversationId,
  listConversations,
  loadLocalReadState,
  markConversationRead,
  markConversationUnread,
  newestSeq,
  rebuildConversations,
  syncChats,
  syncIndex,
} from '@curlew/store';
import { chatMessage, telegramFixture, ANNA } from './chat-fixtures.ts';
import { AT, FakeBackend, freshDb, message } from './fixtures.ts';

/** The person's own read position: kept apart from the network's, so a sync never resets it. All content is synthetic. */

const DIRECT = chatConversationId('telegram', 'telegram-42', '1001');
const unread = (db: ReturnType<typeof freshDb>, id: string) =>
  listConversations(db).find((c) => c.id === id)?.unreadCount;

export default async () => {
  await describe('local read state', async () => {
    await it('survives a sync that still shows the chat unread', async () => {
      const backend = telegramFixture();
      const db = freshDb();
      try {
        await syncChats(db, backend);
        rebuildConversations(db);
        expect(unread(db, DIRECT)).toBe(1);
        expect(markConversationRead(db, DIRECT)).toBe(true);
        expect(unread(db, DIRECT)).toBe(0);
        await syncChats(db, backend, { fullScan: true });
        rebuildConversations(db);
        expect(unread(db, DIRECT)).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('counts a message that arrives after the local read, and lets a later network marker win', async () => {
      const backend = telegramFixture();
      const db = freshDb();
      try {
        await syncChats(db, backend);
        markConversationRead(db, DIRECT);
        backend.post('1001', chatMessage('1001', 4, ANNA, 'Noch da?'));
        await syncChats(db, backend);
        expect(unread(db, DIRECT)).toBe(1);
        backend.markRead('1001', 4, 2);
        await syncChats(db, backend);
        expect(unread(db, DIRECT)).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('marks unread until read again, and journals both changes', async () => {
      const backend = telegramFixture();
      const db = freshDb();
      try {
        backend.markRead('1001', 3, 2);
        await syncChats(db, backend);
        rebuildConversations(db);
        expect(unread(db, DIRECT)).toBe(0);
        const before = newestSeq(db) ?? 0;
        markConversationUnread(db, DIRECT);
        expect(unread(db, DIRECT)).toBe(1);
        expect((newestSeq(db) ?? 0) > before).toBe(true);
        await syncChats(db, backend, { fullScan: true });
        expect(unread(db, DIRECT)).toBe(1);
        markConversationRead(db, DIRECT);
        expect(unread(db, DIRECT)).toBe(0);
        expect(loadLocalReadState(db, DIRECT)?.markedUnread).toBe(false);
        expect(markConversationRead(db, 'nope')).toBe(false);
      } finally {
        db.close();
      }
    });

    await it('holds for a mail conversation across a rebuild', async () => {
      const backend = new FakeBackend();
      backend.put('INBOX', [
        message(1, 'Hallo', 'Hi', {
          messageId: '<m1@example.org>',
          from: [{ name: 'Anna Example', email: 'anna@example.org' }],
          to: [{ name: 'Me', email: 'me@example.com' }],
        }),
      ]);
      const db = freshDb();
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        rebuildConversations(db, {});
        const id = listConversations(db, {})[0]?.id ?? '';
        expect(unread(db, id)).toBe(1);
        markConversationRead(db, id);
        expect(unread(db, id)).toBe(0);
        rebuildConversations(db, {});
        expect(unread(db, id)).toBe(0);
        markConversationUnread(db, id);
        rebuildConversations(db, {});
        expect(unread(db, id)).toBe(1);
      } finally {
        db.close();
      }
    });
  });
};
