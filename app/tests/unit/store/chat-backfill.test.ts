import { describe, expect, it } from '@gjsify/unit';

import type { ChatAttachment } from '@curlew/protocol';
import {
  BACKFILL_CHATS,
  BACKFILL_PAGES,
  chatConversationId,
  getRecentMessages,
  loadAttachments,
  syncChats,
} from '@curlew/store';
import { ANNA, BEN, chatMessage, FakeChatBackend } from './chat-fixtures.ts';
import { AT, freshDb } from './fixtures.ts';

/**
 * Messages stored before the index kept attachment descriptors: the engine walks the history
 * again and writes only the descriptors. Synthetic content only.
 */

const ACCOUNT = 'telegram-42';
const NOW = { now: AT('2026-08-06T12:00:00Z') };

const PHOTO: ChatAttachment = {
  filename: 'photo.jpg',
  mimeType: 'image/jpeg',
  size: 1234,
  kind: 'image',
  width: 800,
  height: 600,
  durationMs: null,
  handle: '{"id":"x"}',
};

function ref(chatId: string, seq: number) {
  return { backend: 'telegram', accountId: ACCOUNT, remoteId: `${chatId}/${seq}` };
}

function backendWith(chatId: string, withAttachments: boolean): FakeChatBackend {
  const backend = new FakeChatBackend();
  backend.addChat({ remoteId: chatId, kind: 'direct', title: 'Anna Example', members: [ANNA] });
  backend.post(
    chatId,
    chatMessage(chatId, 1, ANNA, 'Hallo'),
    chatMessage(chatId, 2, ANNA, 'Bild', { hasAttachments: true }),
    chatMessage(chatId, 3, 'me', 'Schön'),
    chatMessage(chatId, 4, ANNA, null, {
      hasAttachments: true,
      attachments: withAttachments ? [PHOTO] : undefined,
    }),
  );
  return backend;
}

// `seen` is left out: the regular sync derives it from the read marker on every run.
const MESSAGE_ROWS = `SELECT id, body, has_attachments, edited_at, remote_seq FROM conversation_messages ORDER BY id`;

function describeRows(db: ReturnType<typeof freshDb>): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM message_attachments').get() as { n: number }).n);
}

function groupIds(db: ReturnType<typeof freshDb>, chatId: string): Array<string | null> {
  const id = chatConversationId('telegram', ACCOUNT, chatId);
  return getRecentMessages(db, [id], { limit: 100 }).map((m) => m.groupId ?? null);
}

function rawGroups(db: ReturnType<typeof freshDb>): Array<string | null> {
  const rows = db.prepare('SELECT group_id FROM conversation_messages ORDER BY remote_seq').all() as Array<{
    group_id: string | null;
  }>;
  return rows.map((r) => r.group_id);
}

export default async () => {
  await describe('attachment backfill', async () => {
    await it('describes old messages without touching their rows', async () => {
      const db = freshDb();
      try {
        const backend = backendWith('1001', false);
        await syncChats(db, backend, NOW);
        expect(describeRows(db)).toBe(0);
        const rows = () => JSON.stringify(db.prepare(MESSAGE_ROWS).all());
        const before = rows();

        // The network now tells what the old sync did not keep.
        backend.chats.get('1001')!.messages[1].attachments = [PHOTO];
        backend.chats.get('1001')!.messages[3].attachments = [PHOTO];
        backend.rewindable = true;
        await syncChats(db, backend, NOW);

        expect(loadAttachments(db, ref('1001', 2)).length).toBe(1);
        expect(loadAttachments(db, ref('1001', 2))[0].fetchable).toBe(true);
        expect(loadAttachments(db, ref('1001', 4))[0].kind).toBe('image');
        expect(rows()).toBe(before);
      } finally {
        db.close();
      }
    });

    await it('leaves a placeholder where the network shows no attachment any more', async () => {
      const db = freshDb();
      try {
        const backend = backendWith('1001', false);
        await syncChats(db, backend, NOW);
        backend.rewindable = true;
        await syncChats(db, backend, NOW);
        const gone = loadAttachments(db, ref('1001', 2));
        expect(gone.length).toBe(1);
        expect(gone[0].fetchable).toBe(false);
        expect(gone[0].kind).toBe('file');
        // Takes it out of the candidate set: the next run asks nothing.
        const calls = backend.calls.length;
        await syncChats(db, backend, NOW);
        expect(backend.calls.length).toBe(calls);
      } finally {
        db.close();
      }
    });

    await it('skips a network that cannot be walked from a stored seq', async () => {
      const db = freshDb();
      try {
        const backend = backendWith('1001', false);
        await syncChats(db, backend, NOW);
        const calls = backend.calls.length;
        await syncChats(db, backend, NOW);
        expect(backend.calls.length).toBe(calls);
        expect(describeRows(db)).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('stops at a rate limit and keeps the chat for the next run', async () => {
      const db = freshDb();
      try {
        const backend = backendWith('1001', false);
        await syncChats(db, backend, NOW);
        backend.chats.get('1001')!.messages[1].attachments = [PHOTO];
        backend.chats.get('1001')!.messages[3].attachments = [PHOTO];
        backend.rewindable = true;
        backend.rateLimitAtCall = backend.calls.length + 1;
        const result = await syncChats(db, backend, NOW);
        expect(result.accounts[0].chatErrorKinds['rate-limited']).toBe(1);
        expect(describeRows(db)).toBe(0);
        backend.rateLimitAtCall = 0;
        await syncChats(db, backend, NOW);
        expect(describeRows(db)).toBe(2);
      } finally {
        db.close();
      }
    });

    await it('walks a bounded number of chats per run', async () => {
      const db = freshDb();
      try {
        const backend = new FakeChatBackend();
        const total = BACKFILL_CHATS + 3;
        for (let i = 0; i < total; i++) {
          const id = String(2000 + i);
          backend.addChat({ remoteId: id, kind: 'direct', title: `Chat ${i}`, members: [BEN] });
          backend.post(id, chatMessage(id, 1, BEN, null, { hasAttachments: true }));
        }
        await syncChats(db, backend, { ...NOW, maxMessages: 1000 });
        backend.rewindable = true;
        for (const chat of backend.chats.values()) chat.messages[0].attachments = [PHOTO];
        await syncChats(db, backend, NOW);
        expect(describeRows(db)).toBe(BACKFILL_CHATS);
        await syncChats(db, backend, NOW);
        expect(describeRows(db)).toBe(Math.min(total, BACKFILL_CHATS * 2));
        expect(chatConversationId('telegram', ACCOUNT, '2000').length > 0).toBe(true);
      } finally {
        db.close();
      }
    });

    await it('walks a bounded number of pages per chat', async () => {
      const db = freshDb();
      try {
        const backend = new FakeChatBackend();
        backend.addChat({ remoteId: '3001', kind: 'direct', title: 'Long', members: [BEN] });
        const messages = [];
        // One attachment at the start and one far beyond what BACKFILL_PAGES pages reach.
        const count = 100 * (BACKFILL_PAGES + 1);
        for (let seq = 1; seq <= count; seq++) {
          messages.push(chatMessage('3001', seq, BEN, 'x', { hasAttachments: seq === 1 || seq === count }));
        }
        backend.post('3001', ...messages);
        await syncChats(db, backend, { ...NOW, historyDepth: count, maxMessages: count + 10 });
        backend.rewindable = true;
        for (const m of backend.chats.get('3001')!.messages) if (m.hasAttachments) m.attachments = [PHOTO];
        const calls = backend.calls.length;
        await syncChats(db, backend, NOW);
        expect(backend.calls.length - calls <= BACKFILL_PAGES + 1).toBe(true);
        expect(loadAttachments(db, ref('3001', 1)).length).toBe(1);
        expect(loadAttachments(db, ref('3001', count)).length).toBe(0);
        await syncChats(db, backend, NOW);
        expect(loadAttachments(db, ref('3001', count)).length).toBe(1);
      } finally {
        db.close();
      }
    });

    await it('fills in the album of old messages, with and without descriptors', async () => {
      const db = freshDb();
      try {
        const backend = backendWith('1001', false);
        await syncChats(db, backend, NOW);
        // As stored before v15: the column was not there, so it is NULL.
        db.exec('UPDATE conversation_messages SET group_id = NULL');
        expect(rawGroups(db)).toStrictEqual([null, null, null, null]);

        const chat = backend.chats.get('1001')!;
        chat.messages[1].attachments = [PHOTO];
        chat.messages[1].groupId = 'album-1';
        chat.messages[3].attachments = [PHOTO];
        chat.messages[3].groupId = 'album-1';
        backend.rewindable = true;
        backend.groupsMedia = true;
        await syncChats(db, backend, NOW);

        // Only a message with an attachment can be an album part: the others are not looked at.
        expect(rawGroups(db)).toStrictEqual([null, 'album-1', null, 'album-1']);
        expect(groupIds(db, '1001')).toStrictEqual([null, 'album-1', null, 'album-1']);
      } finally {
        db.close();
      }
    });

    await it('keeps the id the sender gave a message, for a reply to name', async () => {
      const db = freshDb();
      try {
        const backend = backendWith('1001', false);
        backend.chats.get('1001')!.messages[0].clientId = 'origin-1';
        await syncChats(db, backend, NOW);
        const id = chatConversationId('telegram', ACCOUNT, '1001');
        const shown = getRecentMessages(db, [id], { limit: 100 });
        expect(shown.map((m) => m.clientId ?? null)).toStrictEqual(['origin-1', null, null, null]);
      } finally {
        db.close();
      }
    });

    await it('leaves a described message its descriptors and asks nothing once its album is known', async () => {
      const db = freshDb();
      try {
        const backend = backendWith('1001', true);
        backend.rewindable = true;
        await syncChats(db, backend, NOW);
        db.exec('UPDATE conversation_messages SET group_id = NULL');
        backend.groupsMedia = true;
        backend.chats.get('1001')!.messages[3].groupId = 'album-2';
        const described = describeRows(db);
        await syncChats(db, backend, NOW);
        expect(describeRows(db)).toBe(described);
        expect(rawGroups(db)).toStrictEqual([null, '', null, 'album-2']);

        const calls = backend.calls.length;
        await syncChats(db, backend, NOW);
        expect(backend.calls.length).toBe(calls);
      } finally {
        db.close();
      }
    });

    await it('does not look for albums on a network that has none', async () => {
      const db = freshDb();
      try {
        const backend = backendWith('1001', true);
        backend.rewindable = true;
        await syncChats(db, backend, NOW);
        db.exec('UPDATE conversation_messages SET group_id = NULL');
        const calls = backend.calls.length;
        await syncChats(db, backend, NOW);
        expect(backend.calls.length).toBe(calls);
        expect(rawGroups(db)).toStrictEqual([null, null, null, null]);
      } finally {
        db.close();
      }
    });

    await it('stores the album id of a freshly synced message', async () => {
      const db = freshDb();
      try {
        const backend = new FakeChatBackend();
        backend.addChat({ remoteId: '1001', kind: 'direct', title: 'Anna Example', members: [ANNA] });
        backend.post(
          '1001',
          chatMessage('1001', 1, ANNA, null, { hasAttachments: true, groupId: 'album-3' }),
          chatMessage('1001', 2, ANNA, 'Hallo'),
        );
        await syncChats(db, backend, NOW);
        expect(rawGroups(db)).toStrictEqual(['album-3', '']);
        expect(groupIds(db, '1001')).toStrictEqual(['album-3', null]);
      } finally {
        db.close();
      }
    });
  });
};
