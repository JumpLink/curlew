import { describe, expect, it } from '@gjsify/unit';

import { type IndexDatabase, conversationTotalsSql } from '@curlew/store';
import { freshDb } from './fixtures.ts';

/**
 * One aggregate statement for both chat engines (`syncChats` scopes by backend + account,
 * `receiveDeliveries` by an id list) — the SET half is shared, the selection stays with the
 * caller. Synthetic ids only.
 */

const BACKEND = 'faketotals';
const ACCOUNT = 'totals-1';

interface Totals {
  message_count: number;
  unread_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
  has_attachments: number;
}

function conversation(db: IndexDatabase, id: string): void {
  db.prepare(
    `INSERT INTO conversations (id, backend, account_id, kind, title, classification, classification_reason)
     VALUES (?, ?, ?, 'chat', ?, 'conversational', 'test')`,
  ).run(id, BACKEND, ACCOUNT, id);
}

function messages(
  db: IndexDatabase,
  conversationId: string,
  rows: readonly [string, number, number][],
): void {
  for (const [id, fromSelf, seen] of rows) {
    db.prepare(
      `INSERT INTO conversation_messages
         (id, conversation_id, backend, account_id, presentation, from_self, seen, has_attachments, sent_at,
          classification, classification_reason)
       VALUES (?, ?, ?, ?, 'message', ?, ?, ?, ?, 'conversational', 'test')`,
    ).run(
      id,
      conversationId,
      BACKEND,
      ACCOUNT,
      fromSelf,
      seen,
      id === 'm2' ? 1 : 0,
      `2026-01-0${id.slice(1)}T00:00:00Z`,
    );
  }
}

function totals(db: IndexDatabase, id: string): Totals {
  const row = db
    .prepare(
      `SELECT message_count, unread_count, first_message_at, last_message_at, has_attachments
         FROM conversations WHERE id = ?`,
    )
    .get(id) as Record<string, unknown>;
  return {
    message_count: Number(row.message_count),
    unread_count: Number(row.unread_count),
    first_message_at: (row.first_message_at as string | null) ?? null,
    last_message_at: (row.last_message_at as string | null) ?? null,
    has_attachments: Number(row.has_attachments),
  };
}

export default async () => {
  await describe('conversation totals', () => {
    it('summarises the messages beneath a conversation', () => {
      const db = freshDb();
      try {
        conversation(db, 'c1');
        // One incoming unread, one incoming read, one of the user's own.
        messages(db, 'c1', [
          ['m1', 0, 0],
          ['m2', 0, 1],
          ['m3', 1, 1],
        ]);
        db.prepare(conversationTotalsSql(`id IN (?)`)).run('c1');
        expect(totals(db, 'c1')).toStrictEqual({
          message_count: 3,
          unread_count: 1,
          first_message_at: '2026-01-01T00:00:00Z',
          last_message_at: '2026-01-03T00:00:00Z',
          has_attachments: 1,
        });
      } finally {
        db.close();
      }
    });

    it('leaves rows the caller did not select alone, in both shapes', () => {
      const db = freshDb();
      try {
        conversation(db, 'c1');
        conversation(db, 'c2');
        messages(db, 'c1', [['m1', 0, 0]]);
        messages(db, 'c2', [
          ['m2', 0, 1],
          ['m3', 0, 1],
        ]);
        db.prepare(
          `INSERT INTO chat_cursors (conversation_id, backend, account_id, chat_id, kind, last_seq)
           VALUES ('c1', ?, ?, 'chat-1', 'direct', 1)`,
        ).run(BACKEND, ACCOUNT);

        // `syncChats`: the backend's own chats, named through their cursor rows.
        db.prepare(
          conversationTotalsSql(
            `backend = ? AND account_id = ?
               AND id IN (SELECT conversation_id FROM chat_cursors WHERE backend = ? AND account_id = ?)`,
          ),
        ).run(BACKEND, ACCOUNT, BACKEND, ACCOUNT);
        expect(totals(db, 'c1').message_count).toBe(1);
        expect(totals(db, 'c2').message_count).toBe(0);

        // `receiveDeliveries`: the ids the batch touched.
        db.prepare(conversationTotalsSql(`id IN (?)`)).run('c2');
        expect(totals(db, 'c2').message_count).toBe(2);
        expect(totals(db, 'c2').has_attachments).toBe(1);
      } finally {
        db.close();
      }
    });
  });
};
