import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrate, openIndexDb, SCHEMA_VERSION } from '@curlew/store';

/**
 * The index at schema 24, written out by hand: the DDL a user's index.db has on disk, NOT what
 * `migrate` would create today. Every future `UPGRADES` step must open this file and keep its rows.
 * Never regenerate it from `schema.ts` — a baseline that follows the code proves nothing.
 * Synthetic rows only.
 */
const V24_BASELINE = 24;
const V24_DDL: readonly string[] = [
  `CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE accounts (id TEXT PRIMARY KEY, identity TEXT, provider TEXT, last_sync_at TEXT, link_dropped_at TEXT, address TEXT)`,
  `CREATE TABLE folders (account_id TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, role TEXT, uid_validity INTEGER, uid_next INTEGER, last_uid INTEGER NOT NULL DEFAULT 0, message_count INTEGER, sync_enabled INTEGER NOT NULL DEFAULT 1, last_sync_at TEXT, PRIMARY KEY (account_id, path))`,
  `CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, folder_path TEXT NOT NULL, uid INTEGER NOT NULL, message_id TEXT, subject TEXT, sender TEXT, recipients TEXT, date TEXT, internal_date TEXT, size INTEGER, seen INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, has_attachment INTEGER NOT NULL DEFAULT 0, indexed_at TEXT NOT NULL, in_reply_to TEXT, thread_refs TEXT, from_json TEXT, to_json TEXT, list_id TEXT, list_unsubscribe TEXT, auto_submitted TEXT, precedence TEXT, email_chat INTEGER NOT NULL DEFAULT 0, encrypted INTEGER NOT NULL DEFAULT 0, chat_edit TEXT, chat_delete TEXT, reaction INTEGER NOT NULL DEFAULT 0, chat_content TEXT, chat_duration_ms INTEGER, mdn INTEGER NOT NULL DEFAULT 0, mdn_for TEXT, receipt_to TEXT)`,
  `CREATE UNIQUE INDEX messages_uid ON messages (account_id, folder_path, uid)`,
  `CREATE INDEX messages_date ON messages (date DESC)`,
  `CREATE INDEX messages_folder ON messages (account_id, folder_path)`,
  `CREATE TABLE attachments (message_id INTEGER NOT NULL, section TEXT NOT NULL, filename TEXT, mime_type TEXT, size INTEGER, PRIMARY KEY (message_id, section))`,
  `CREATE TABLE message_attachments (message_id TEXT NOT NULL, idx INTEGER NOT NULL, filename TEXT, mime_type TEXT, size INTEGER, kind TEXT, width INTEGER, height INTEGER, duration_ms INTEGER, handle TEXT, PRIMARY KEY (message_id, idx))`,
  `CREATE VIRTUAL TABLE messages_fts USING fts5(subject, sender, recipients, body, tokenize="unicode61 remove_diacritics 2")`,
  `CREATE TABLE sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT, account_id TEXT, folder_path TEXT, added INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, error TEXT)`,
  `CREATE TABLE participants (id TEXT PRIMARY KEY, display_name TEXT, contact_uid TEXT)`,
  `CREATE TABLE participant_addresses (participant_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, value))`,
  `CREATE INDEX participant_addresses_owner ON participant_addresses (participant_id)`,
  `CREATE TABLE conversations (id TEXT PRIMARY KEY, backend TEXT NOT NULL, account_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT, classification TEXT NOT NULL, classification_reason TEXT NOT NULL, first_message_at TEXT, last_message_at TEXT, message_count INTEGER NOT NULL DEFAULT 0, unread_count INTEGER NOT NULL DEFAULT 0, has_attachments INTEGER NOT NULL DEFAULT 0, email_chat INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX conversations_last ON conversations (last_message_at DESC)`,
  `CREATE TABLE conversation_participants (conversation_id TEXT NOT NULL, participant_id TEXT NOT NULL, PRIMARY KEY (conversation_id, participant_id))`,
  `CREATE TABLE conversation_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, backend TEXT NOT NULL, account_id TEXT NOT NULL, presentation TEXT NOT NULL, sender_participant_id TEXT, sender_name TEXT, sender_kind TEXT, sender_address TEXT, from_self INTEGER NOT NULL DEFAULT 0, sent_at TEXT, subject TEXT, seen INTEGER NOT NULL DEFAULT 0, has_attachments INTEGER NOT NULL DEFAULT 0, classification TEXT NOT NULL, classification_reason TEXT NOT NULL, folder_path TEXT, uid INTEGER, remote_id TEXT, body TEXT, remote_seq INTEGER, sender_peer_id TEXT, edited_at TEXT, reply_to_remote_id TEXT, thread_remote_id TEXT, peer_read INTEGER, reply_to_client_id TEXT, email_chat INTEGER NOT NULL DEFAULT 0, group_id TEXT, client_id TEXT, encrypted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX conversation_messages_conv ON conversation_messages (conversation_id, sent_at)`,
  `CREATE TABLE chat_peers (backend TEXT NOT NULL, account_id TEXT NOT NULL, peer_id TEXT NOT NULL, display_name TEXT, addresses_json TEXT, is_bot INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (backend, account_id, peer_id))`,
  `CREATE TABLE chat_peer_links (backend TEXT NOT NULL, account_id TEXT NOT NULL, peer_id TEXT NOT NULL, participant_id TEXT NOT NULL, PRIMARY KEY (backend, account_id, peer_id))`,
  `CREATE TABLE chat_members (conversation_id TEXT NOT NULL, backend TEXT NOT NULL, account_id TEXT NOT NULL, peer_id TEXT NOT NULL, PRIMARY KEY (conversation_id, peer_id))`,
  `CREATE TABLE chat_cursors (conversation_id TEXT PRIMARY KEY, backend TEXT NOT NULL, account_id TEXT NOT NULL, chat_id TEXT NOT NULL, kind TEXT NOT NULL, last_seq INTEGER, read_inbox_seq INTEGER, read_outbox_seq INTEGER, last_sync_at TEXT, last_cursor TEXT, probe_seq INTEGER, room_public INTEGER, room_encrypted INTEGER, room_members INTEGER, peer_features TEXT)`,
  `CREATE INDEX conversation_messages_seq ON conversation_messages (conversation_id, remote_seq)`,
  `CREATE INDEX conversation_messages_remote ON conversation_messages (backend, account_id, remote_id)`,
  `CREATE TABLE receive_leases (backend TEXT NOT NULL, account_id TEXT NOT NULL, holder TEXT NOT NULL, heartbeat_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (backend, account_id))`,
  `CREATE TABLE index_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('messages', 'conversations', 'accounts')), backend TEXT, account_id TEXT, conversation_id TEXT)`,
  `CREATE TABLE message_reactions (message_id TEXT NOT NULL, reactor TEXT NOT NULL, emoji TEXT NOT NULL, event_id TEXT, PRIMARY KEY (message_id, reactor, emoji))`,
  `CREATE TABLE mail_receipts_sent (account_id TEXT NOT NULL, message_id TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (account_id, message_id))`,
];

const count = (db: ReturnType<typeof openIndexDb>, table: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

export default async () => {
  await describe('opening an index written at schema 24', async () => {
    await it('keeps delivery-only messages and mail rows through migrate', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-baseline-'));
      try {
        const path = join(dir, 'index.db');
        const old = openIndexDb(path);
        for (const sql of V24_DDL) old.exec(sql);
        old
          .prepare(`INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)`)
          .run(String(V24_BASELINE));
        old.exec(`INSERT INTO accounts (id, identity, provider) VALUES ('sig-1', 'Test Person', 'signal')`);
        old.exec(`INSERT INTO accounts (id, identity, provider) VALUES ('mail-1', 'a@example.org', 'mail')`);
        old.exec(
          `INSERT INTO conversations (id, backend, account_id, kind, classification, classification_reason, message_count)
           VALUES ('signal:sig-1:c1', 'signal', 'sig-1', 'direct', 'known', 'test', 2)`,
        );
        old.exec(
          `INSERT INTO conversation_messages (id, conversation_id, backend, account_id, presentation, classification, classification_reason, body, remote_id)
           VALUES ('signal:sig-1:c1:m1', 'signal:sig-1:c1', 'signal', 'sig-1', 'chat', 'known', 'test', 'only copy one', 'r1')`,
        );
        old.exec(
          `INSERT INTO conversation_messages (id, conversation_id, backend, account_id, presentation, classification, classification_reason, body, remote_id)
           VALUES ('signal:sig-1:c1:m2', 'signal:sig-1:c1', 'signal', 'sig-1', 'chat', 'known', 'test', 'only copy two', 'r2')`,
        );
        old.exec(
          `INSERT INTO folders (account_id, path, name, last_uid) VALUES ('mail-1', 'INBOX', 'Inbox', 7)`,
        );
        old.exec(
          `INSERT INTO messages (account_id, folder_path, uid, subject, indexed_at) VALUES ('mail-1', 'INBOX', 7, 'Hello', 't')`,
        );
        old.exec(
          `INSERT INTO mail_receipts_sent (account_id, message_id, sent_at) VALUES ('mail-1', '<m@example.org>', 1)`,
        );
        old.close();

        const db = openIndexDb(path);
        try {
          migrate(db);
          const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
            value: string;
          };
          expect(Number(version.value)).toBe(SCHEMA_VERSION);
          expect(count(db, 'conversation_messages')).toBe(2);
          const bodies = (
            db.prepare('SELECT body FROM conversation_messages ORDER BY id').all() as Array<{ body: string }>
          ).map((r) => r.body);
          expect(bodies).toStrictEqual(['only copy one', 'only copy two']);
          expect(count(db, 'conversations')).toBe(1);
          expect(count(db, 'messages')).toBe(1);
          expect(count(db, 'mail_receipts_sent')).toBe(1);
          expect(count(db, 'accounts')).toBe(2);
        } finally {
          db.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
