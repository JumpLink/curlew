import { describe, expect, it } from '@gjsify/unit';

import {
  appendChanges,
  CHANGES_KEEP_MS,
  CHANGES_KEEP_ROWS,
  migrate,
  readChanges,
  upsertAccount,
  SCHEMA_VERSION,
} from '@curlew/store';
import { freshDb } from './fixtures.ts';

/**
 * The change journal (ADR 0007 §1). Synthetic ids only; a row names a place, never content.
 */

const T0 = new Date('2026-11-01T10:00:00.000Z');

export default async () => {
  await describe('the change journal', async () => {
    await it('is empty on a fresh index, with no bounds', async () => {
      const db = freshDb();
      try {
        const read = readChanges(db, 0, 10);
        expect(read.changes.length).toBe(0);
        expect(read.oldest).toBe(null);
        expect(read.newest).toBe(null);
      } finally {
        db.close();
      }
    });

    await it('reads rows after a cursor, oldest first, within the limit', async () => {
      const db = freshDb();
      try {
        for (const id of ['c-1', 'c-2', 'c-3']) {
          appendChanges(
            db,
            [{ kind: 'messages', backend: 'xmpp', accountId: 'a-1', conversationId: id }],
            T0,
          );
        }
        const all = readChanges(db, 0, 10);
        expect(all.changes.map((c) => c.conversationId).join(',')).toBe('c-1,c-2,c-3');
        expect(all.oldest).toBe(all.changes[0].seq);
        expect(all.newest).toBe(all.changes[2].seq);
        const rest = readChanges(db, all.changes[0].seq, 1);
        expect(rest.changes.map((c) => c.conversationId).join(',')).toBe('c-2');
        expect(rest.newest).toBe(all.newest);
        expect(all.changes[0].at).toBe(T0.toISOString());
      } finally {
        db.close();
      }
    });

    await it('writes one row per distinct place in a batch', async () => {
      const db = freshDb();
      try {
        const place = { kind: 'messages' as const, backend: 'xmpp', accountId: 'a-1', conversationId: 'c-1' };
        appendChanges(db, [place, place, { ...place, conversationId: 'c-2' }, place], T0);
        expect(readChanges(db, 0, 10).changes.length).toBe(2);
        // The next batch is a new moment: the same place is a new row.
        appendChanges(db, [place], T0);
        expect(readChanges(db, 0, 10).changes.length).toBe(3);
      } finally {
        db.close();
      }
    });

    await it('an empty batch appends nothing', async () => {
      const db = freshDb();
      try {
        appendChanges(db, [], T0);
        expect(readChanges(db, 0, 10).newest).toBe(null);
      } finally {
        db.close();
      }
    });

    await it('prunes only rows that are both beyond the count and older than 7 days', async () => {
      const db = freshDb();
      try {
        const old = new Date(T0.getTime() - CHANGES_KEEP_MS - 60_000);
        const rows = Array.from({ length: CHANGES_KEEP_ROWS + 5 }, (_, i) => ({
          kind: 'conversations' as const,
          conversationId: `c-${i}`,
        }));
        // Old and beyond the count: the first five go, the rest stay on the count.
        appendChanges(db, rows, old);
        appendChanges(db, [{ kind: 'accounts' }], T0);
        const after = readChanges(db, 0, 1);
        expect(after.newest! - after.oldest! + 1).toBe(CHANGES_KEEP_ROWS);
        // Young rows survive however many there are.
        const db2 = freshDb();
        try {
          appendChanges(db2, rows, T0);
          appendChanges(db2, [{ kind: 'accounts' }], T0);
          const young = readChanges(db2, 0, 1);
          expect(young.newest! - young.oldest! + 1).toBe(CHANGES_KEEP_ROWS + 6);
        } finally {
          db2.close();
        }
      } finally {
        db.close();
      }
    });

    await it('migrates a v9 index forward without touching a stored row', async () => {
      const db = freshDb();
      try {
        db.prepare(
          `INSERT INTO conversation_messages (id, conversation_id, backend, account_id, presentation,
             from_self, seen, has_attachments, classification, classification_reason, remote_id, body)
           VALUES ('m-1', 'c-1', 'xmpp', 'a-1', 'bubble', 0, 0, 0, 'conversational', 'known-contact', 'x-1', 'bleibt')`,
        ).run();
        db.prepare(`UPDATE schema_meta SET value = '9' WHERE key = 'schema_version'`).run();
        db.exec('DROP TABLE index_changes');
        expect(() => migrate(db)).not.toThrow();
        const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
          value: string;
        };
        expect(version.value).toBe(String(SCHEMA_VERSION));
        expect(SCHEMA_VERSION).toBe(17);
        const kept = db.prepare('SELECT body FROM conversation_messages WHERE id = ?').get('m-1') as {
          body: string;
        };
        expect(kept.body).toBe('bleibt');
        appendChanges(db, [{ kind: 'accounts' }], T0);
        expect(readChanges(db, 0, 10).changes.length).toBe(1);
      } finally {
        db.close();
      }
    });

    await it('migrates a v12 index to v13, adding room facts and the account address as unknown', async () => {
      const db = freshDb();
      try {
        db.prepare(`INSERT INTO accounts (id, identity) VALUES ('acc-1', 'wa-1')`).run();
        db.exec('ALTER TABLE accounts DROP COLUMN address');
        db.exec('ALTER TABLE chat_cursors DROP COLUMN room_public');
        db.exec('ALTER TABLE chat_cursors DROP COLUMN room_encrypted');
        db.exec('ALTER TABLE chat_cursors DROP COLUMN room_members');
        db.prepare(`UPDATE schema_meta SET value = '12' WHERE key = 'schema_version'`).run();
        expect(() => migrate(db)).not.toThrow();
        const row = db.prepare('SELECT identity, address FROM accounts WHERE id = ?').get('acc-1') as {
          identity: string;
          address: string | null;
        };
        expect(row.identity).toBe('wa-1');
        expect(row.address).toBe(null);
        db.prepare(
          `INSERT INTO chat_cursors (conversation_id, backend, account_id, chat_id, kind, room_public)
           VALUES ('c-1', 'matrix', 'acc-1', '!r:example.org', 'group', 1)`,
        ).run();
      } finally {
        db.close();
      }
    });

    await it('keeps a stored account address when a later upsert has none', async () => {
      const db = freshDb();
      try {
        upsertAccount(db, {
          id: 'a-1',
          identity: 'wa-1',
          provider: 'whatsapp',
          address: '4915100000000@s.whatsapp.net',
        });
        upsertAccount(db, { id: 'a-1', identity: 'wa-1', provider: 'whatsapp' });
        const row = db.prepare('SELECT address FROM accounts WHERE id = ?').get('a-1') as {
          address: string | null;
        };
        expect(row.address).toBe('4915100000000@s.whatsapp.net');
      } finally {
        db.close();
      }
    });

    await it('migrates a v10 index to v11 by re-fetching mail, keeping every stored row', async () => {
      const db = freshDb();
      try {
        db.prepare(
          `INSERT INTO folders (account_id, path, name, uid_validity, uid_next, last_uid, message_count)
           VALUES ('a-1', 'INBOX', 'INBOX', 7, 43, 42, 40)`,
        ).run();
        db.prepare(
          `INSERT INTO conversation_messages (id, conversation_id, backend, account_id, presentation,
             from_self, seen, has_attachments, classification, classification_reason, remote_id, body)
           VALUES ('m-1', 'c-1', 'xmpp', 'a-1', 'bubble', 0, 0, 0, 'conversational', 'known-contact', 'x-1', 'bleibt')`,
        ).run();
        db.prepare(`UPDATE schema_meta SET value = '10' WHERE key = 'schema_version'`).run();
        expect(() => migrate(db)).not.toThrow();
        const folder = db
          .prepare(`SELECT uid_validity, uid_next, last_uid, message_count FROM folders WHERE path = 'INBOX'`)
          .get() as {
          uid_validity: number;
          uid_next: number | null;
          last_uid: number;
          message_count: number | null;
        };
        expect(folder.last_uid).toBe(0);
        expect(folder.uid_next).toBe(null);
        expect(folder.message_count).toBe(null);
        expect(folder.uid_validity).toBe(7);
        const kept = db
          .prepare('SELECT body, email_chat FROM conversation_messages WHERE id = ?')
          .get('m-1') as { body: string; email_chat: number };
        expect(kept.body).toBe('bleibt');
        expect(kept.email_chat).toBe(0);
      } finally {
        db.close();
      }
    });
  });
};
