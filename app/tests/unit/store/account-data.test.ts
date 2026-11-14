import { describe, expect, it } from '@gjsify/unit';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deleteAccountData, type IndexDatabase, readChanges, upsertAccount } from '@curlew/store';

import { accountDataDelete } from '../../../src/core/actions/accounts.ts';
import { avatarAccountDir, avatarFiles } from '../../../src/core/lib/avatar-cache.ts';
import { freshDb } from './fixtures.ts';

/** Synthetic rows only: example.org addresses, made-up ids. */

const SIMPLE_TABLES = [
  'accounts',
  'conversations',
  'conversation_messages',
  'conversation_participants',
  'message_attachments',
  'message_reactions',
  'chat_peers',
  'chat_peer_links',
  'chat_members',
  'chat_cursors',
  'receive_leases',
  'participants',
  'participant_addresses',
  'messages',
  'messages_fts',
  'attachments',
  'folders',
  'sync_log',
];

function counts(db: IndexDatabase): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of SIMPLE_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    out[table] = Number(row.n);
  }
  return out;
}

function seedChat(db: IndexDatabase, backend: string, account: string): void {
  upsertAccount(db, { id: account, identity: 'Test Person', provider: backend });
  const conv = `${backend}:${account}:c1`;
  const msg = `${conv}:m1`;
  db.prepare(
    `INSERT INTO conversations (id, backend, account_id, kind, classification, classification_reason)
     VALUES (?, ?, ?, 'direct', 'known', 'test')`,
  ).run(conv, backend, account);
  db.prepare(
    `INSERT INTO conversation_messages (id, conversation_id, backend, account_id, presentation, classification, classification_reason)
     VALUES (?, ?, ?, ?, 'chat', 'known', 'test')`,
  ).run(msg, conv, backend, account);
  db.prepare('INSERT INTO message_attachments (message_id, idx) VALUES (?, 0)').run(msg);
  db.prepare("INSERT INTO message_reactions (message_id, reactor, emoji) VALUES (?, 'p', 'x')").run(msg);
  const participant = `${backend}-${account}-peer`;
  db.prepare('INSERT INTO participants (id, display_name) VALUES (?, ?)').run(participant, 'Peer');
  db.prepare("INSERT INTO participant_addresses (participant_id, kind, value) VALUES (?, 'chat', ?)").run(
    participant,
    `${backend}-${account}@example.org`,
  );
  db.prepare('INSERT INTO conversation_participants (conversation_id, participant_id) VALUES (?, ?)').run(
    conv,
    participant,
  );
  db.prepare('INSERT INTO chat_peers (backend, account_id, peer_id) VALUES (?, ?, ?)').run(
    backend,
    account,
    'p1',
  );
  db.prepare(
    'INSERT INTO chat_peer_links (backend, account_id, peer_id, participant_id) VALUES (?, ?, ?, ?)',
  ).run(backend, account, 'p1', participant);
  db.prepare(
    'INSERT INTO chat_members (conversation_id, backend, account_id, peer_id) VALUES (?, ?, ?, ?)',
  ).run(conv, backend, account, 'p1');
  db.prepare(
    "INSERT INTO chat_cursors (conversation_id, backend, account_id, chat_id, kind) VALUES (?, ?, ?, 'c1', 'direct')",
  ).run(conv, backend, account);
  db.prepare(
    "INSERT INTO receive_leases (backend, account_id, holder, heartbeat_at, expires_at) VALUES (?, ?, 'h', 't', 't')",
  ).run(backend, account);
}

function seedMail(db: IndexDatabase, account: string): void {
  upsertAccount(db, { id: account, identity: `${account}@example.org`, provider: 'mail' });
  db.prepare("INSERT INTO folders (account_id, path, name) VALUES (?, 'INBOX', 'Inbox')").run(account);
  db.prepare(
    "INSERT INTO messages (account_id, folder_path, uid, indexed_at) VALUES (?, 'INBOX', 1, 't')",
  ).run(account);
  const row = db.prepare('SELECT MAX(id) AS id FROM messages').get() as { id: number };
  db.prepare(
    'INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)',
  ).run(Number(row.id), 'Hello', 'a@example.org', 'b@example.org', 'plain body');
  db.prepare("INSERT INTO attachments (message_id, section) VALUES (?, '2')").run(Number(row.id));
  db.prepare('INSERT INTO sync_log (started_at, account_id) VALUES (?, ?)').run('t', account);
  db.prepare(
    "INSERT INTO mail_receipts_sent (account_id, message_id, sent_at) VALUES (?, '<m@example.org>', 1)",
  ).run(account);
}

export default async () => {
  await describe('deleting an account from the index', async () => {
    await it('removes every row of a chat account and leaves another one untouched', async () => {
      const db = freshDb();
      try {
        seedChat(db, 'signal', 'signal-a');
        const onlyB = counts(db);
        seedChat(db, 'signal', 'signal-b');
        seedChat(db, 'matrix', 'signal-a');
        const before = counts(db);

        const removed = deleteAccountData(db, 'signal', 'signal-a');
        expect(removed.messages).toBe(1);
        expect(removed.conversations).toBe(1);

        const after = counts(db);
        // Two accounts of the same kind remain: signal-b and matrix/signal-a (same id, other backend).
        for (const table of SIMPLE_TABLES) {
          expect(after[table]).toBe(before[table] - onlyB[table]);
        }
        const left = db
          .prepare(
            "SELECT COUNT(*) AS n FROM conversations WHERE backend = 'signal' AND account_id = 'signal-a'",
          )
          .get() as { n: number };
        expect(Number(left.n)).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('removes a mail account with its FTS rows and keeps the FTS table consistent', async () => {
      const db = freshDb();
      try {
        seedMail(db, 'mail-a');
        seedMail(db, 'mail-b');
        deleteAccountData(db, 'mail', 'mail-a');
        const c = counts(db);
        expect(c.messages).toBe(1);
        expect(c.messages_fts).toBe(1);
        expect(c.attachments).toBe(1);
        expect(c.folders).toBe(1);
        expect(c.sync_log).toBe(1);
        expect(c.accounts).toBe(1);
        const orphans = db
          .prepare('SELECT COUNT(*) AS n FROM messages_fts WHERE rowid NOT IN (SELECT id FROM messages)')
          .get() as { n: number };
        expect(Number(orphans.n)).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('leaves no row with an account_id column behind, whichever table it is in', async () => {
      const db = freshDb();
      try {
        seedMail(db, 'mail-a');
        seedMail(db, 'mail-b');
        const tables = (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .all() as Array<{ name: string }>
        )
          .map((r) => String(r.name))
          // The change journal records the removal itself, so it keeps the account id on purpose.
          .filter((name) => name !== 'index_changes')
          .filter((name) =>
            (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name?: string }>).some(
              (c) => c.name === 'account_id',
            ),
          );
        expect(tables.includes('mail_receipts_sent')).toBe(true);
        const n = (table: string, account: string): number =>
          Number(
            (
              db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`).get(account) as {
                n: number;
              }
            ).n,
          );
        const otherBefore = tables.map((t) => n(t, 'mail-b'));
        deleteAccountData(db, 'mail', 'mail-a');
        for (const t of tables) expect(n(t, 'mail-a')).toBe(0);
        expect(tables.map((t) => n(t, 'mail-b'))).toStrictEqual(otherBefore);
      } finally {
        db.close();
      }
    });

    await it('keeps a participant that another account still uses', async () => {
      const db = freshDb();
      try {
        seedChat(db, 'signal', 'signal-a');
        db.prepare(
          'INSERT INTO conversation_participants (conversation_id, participant_id) VALUES (?, ?)',
        ).run('other-conv', 'signal-signal-a-peer');
        deleteAccountData(db, 'signal', 'signal-a');
        expect(counts(db).participants).toBe(1);
      } finally {
        db.close();
      }
    });

    await it('journals the removal so open windows reload', async () => {
      const db = freshDb();
      try {
        seedChat(db, 'signal', 'signal-a');
        deleteAccountData(db, 'signal', 'signal-a');
        const kinds = readChanges(db, 0)
          .changes.map((c) => c.kind)
          .sort();
        expect(kinds.join(',')).toBe('accounts,conversations,messages');
      } finally {
        db.close();
      }
    });

    await it('deleting an unknown account changes nothing', async () => {
      const db = freshDb();
      try {
        seedChat(db, 'signal', 'signal-b');
        const before = counts(db);
        deleteAccountData(db, 'signal', 'signal-missing');
        expect(counts(db)).toStrictEqual(before);
      } finally {
        db.close();
      }
    });

    await it('also clears the avatar directory of that account and the previews', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-acc-data-'));
      try {
        const dbPath = join(dir, 'index.db');
        const avatars = join(dir, 'avatars');
        const previews = join(dir, 'previews');
        const files = avatarFiles(avatars, 'signal', 'signal-a', 'peer');
        const otherFiles = avatarFiles(avatars, 'signal', 'signal-b', 'peer');
        for (const f of [files.image, otherFiles.image]) {
          mkdirSync(join(f, '..'), { recursive: true });
          writeFileSync(f, 'x');
        }
        mkdirSync(previews, { recursive: true });
        writeFileSync(join(previews, 'p'), 'x');

        const seeded = (await import('@curlew/store')).openIndexDb(dbPath);
        (await import('@curlew/store')).migrate(seeded);
        seedChat(seeded, 'signal', 'signal-a');
        seedChat(seeded, 'signal', 'signal-b');
        seeded.close();

        const removed = accountDataDelete('signal', 'signal-a', {
          dbPath,
          avatarsRoot: avatars,
          previewsRoot: previews,
        });
        expect(removed.messages).toBe(1);
        expect(existsSync(avatarAccountDir(avatars, 'signal', 'signal-a'))).toBe(false);
        expect(existsSync(otherFiles.image)).toBe(true);
        expect(existsSync(previews)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
