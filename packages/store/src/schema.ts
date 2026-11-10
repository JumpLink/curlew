/**
 * Index schema and migration — versioned via SCHEMA_VERSION + the UPGRADES array.
 *
 * Two decisions here are forced by the libgda-backed `node:sqlite` (see AGENTS.md in this
 * directory), and both look odd without that context:
 *
 *   - **No FTS triggers.** `exec()` splits multi-statement strings itself and does not
 *     understand `BEGIN … END`, so a trigger body would be cut into broken fragments. The FTS
 *     table is maintained by application code inside the same transaction as the `messages`
 *     write — which is better anyway: an `AFTER UPDATE` trigger would fire on every flag change
 *     and rewrite the whole FTS row for a `\Seen` toggle.
 *   - **A plain FTS5 table, not `content=''` external content.** External content needs the
 *     `('delete', rowid, …)` command form to remove a row, and a `'rebuild'` after any drift.
 *     A plain table deletes with `DELETE … WHERE rowid = ?`. The searchable text is therefore
 *     stored ONCE — in the FTS table — and `messages` deliberately has no `body` column, so
 *     nothing is duplicated.
 *
 * One statement per array entry, and NO SQL comments inside these strings: the splitter is not
 * a SQL parser. Documentation belongs in JS comments like this one.
 */

import { type IndexDatabase, withTransaction } from './db.ts';
import { LOCAL_ECHO_PREFIX } from './local-echo.ts';

export const SCHEMA_VERSION = 16;

/**
 * The FTS5 DDL. Defined once so the baseline and any future rebuild cannot drift.
 *
 * `remove_diacritics 2` is what makes "marz" find "März" and "Grusse" find "Grüße" — decisive
 * for a German mailbox searched from a keyboard that may not have umlauts to hand.
 */
const FTS_TABLE =
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(` +
  `subject, sender, recipients, body, ` +
  `tokenize="unicode61 remove_diacritics 2")`;

const STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS accounts (
     id TEXT PRIMARY KEY,
     identity TEXT,
     provider TEXT,
     last_sync_at TEXT)`,

  // `path` is the WIRE name (modified UTF-7) and is the key, because it is what a server
  // accepts and what stays stable; `name` is the decoded form, for display only.
  // `last_uid` is the sync cursor: everything at or below it has been seen.
  `CREATE TABLE IF NOT EXISTS folders (
     account_id TEXT NOT NULL,
     path TEXT NOT NULL,
     name TEXT NOT NULL,
     role TEXT,
     uid_validity INTEGER,
     uid_next INTEGER,
     last_uid INTEGER NOT NULL DEFAULT 0,
     message_count INTEGER,
     sync_enabled INTEGER NOT NULL DEFAULT 1,
     last_sync_at TEXT,
     PRIMARY KEY (account_id, path))`,

  // No `body` column on purpose — the body lives once, in messages_fts.
  `CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     account_id TEXT NOT NULL,
     folder_path TEXT NOT NULL,
     uid INTEGER NOT NULL,
     message_id TEXT,
     subject TEXT,
     sender TEXT,
     recipients TEXT,
     date TEXT,
     internal_date TEXT,
     size INTEGER,
     seen INTEGER NOT NULL DEFAULT 0,
     flagged INTEGER NOT NULL DEFAULT 0,
     has_attachment INTEGER NOT NULL DEFAULT 0,
     indexed_at TEXT NOT NULL)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS messages_uid ON messages (account_id, folder_path, uid)`,
  `CREATE INDEX IF NOT EXISTS messages_date ON messages (date DESC)`,
  `CREATE INDEX IF NOT EXISTS messages_folder ON messages (account_id, folder_path)`,

  `CREATE TABLE IF NOT EXISTS attachments (
     message_id INTEGER NOT NULL,
     section TEXT NOT NULL,
     filename TEXT,
     mime_type TEXT,
     size INTEGER,
     PRIMARY KEY (message_id, section))`,

  // Chat message attachments: one row per part. `idx` is the order from the backend; `handle`
  // is opaque to everyone but the backend and never leaves `@curlew/store`.
  `CREATE TABLE IF NOT EXISTS message_attachments (
     message_id TEXT NOT NULL,
     idx INTEGER NOT NULL,
     filename TEXT,
     mime_type TEXT,
     size INTEGER,
     kind TEXT,
     width INTEGER,
     height INTEGER,
     duration_ms INTEGER,
     handle TEXT,
     PRIMARY KEY (message_id, idx))`,

  FTS_TABLE,

  `CREATE TABLE IF NOT EXISTS sync_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     account_id TEXT,
     folder_path TEXT,
     added INTEGER NOT NULL DEFAULT 0,
     updated INTEGER NOT NULL DEFAULT 0,
     removed INTEGER NOT NULL DEFAULT 0,
     error TEXT)`,

  // ── conversations (v2) ─────────────────────────────────────────────
  // Derived tables: `rebuildConversations` rewrites them from `messages` after each sync,
  // so they never hold anything the mail rows do not. A delivery-only backend will write its
  // own rows here directly, and at that point they become the only copy (ADR 0001 §2).

  `CREATE TABLE IF NOT EXISTS participants (
     id TEXT PRIMARY KEY,
     display_name TEXT,
     contact_uid TEXT)`,

  // (kind, value) is the key: one address belongs to exactly one participant.
  `CREATE TABLE IF NOT EXISTS participant_addresses (
     participant_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (kind, value))`,

  `CREATE INDEX IF NOT EXISTS participant_addresses_owner ON participant_addresses (participant_id)`,

  `CREATE TABLE IF NOT EXISTS conversations (
     id TEXT PRIMARY KEY,
     backend TEXT NOT NULL,
     account_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     title TEXT,
     classification TEXT NOT NULL,
     classification_reason TEXT NOT NULL,
     first_message_at TEXT,
     last_message_at TEXT,
     message_count INTEGER NOT NULL DEFAULT 0,
     unread_count INTEGER NOT NULL DEFAULT 0,
     has_attachments INTEGER NOT NULL DEFAULT 0)`,

  `CREATE INDEX IF NOT EXISTS conversations_last ON conversations (last_message_at DESC)`,

  `CREATE TABLE IF NOT EXISTS conversation_participants (
     conversation_id TEXT NOT NULL,
     participant_id TEXT NOT NULL,
     PRIMARY KEY (conversation_id, participant_id))`,

  // `folder_path` + `uid` locate a mail message for `mail_get_message`; every other backend
  // leaves them null and stores the network's own message id in `remote_id`.
  `CREATE TABLE IF NOT EXISTS conversation_messages (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL,
     backend TEXT NOT NULL,
     account_id TEXT NOT NULL,
     presentation TEXT NOT NULL,
     sender_participant_id TEXT,
     sender_name TEXT,
     sender_kind TEXT,
     sender_address TEXT,
     from_self INTEGER NOT NULL DEFAULT 0,
     sent_at TEXT,
     subject TEXT,
     seen INTEGER NOT NULL DEFAULT 0,
     has_attachments INTEGER NOT NULL DEFAULT 0,
     classification TEXT NOT NULL,
     classification_reason TEXT NOT NULL,
     folder_path TEXT,
     uid INTEGER,
     remote_id TEXT)`,

  `CREATE INDEX IF NOT EXISTS conversation_messages_conv ON conversation_messages (conversation_id, sent_at)`,

  // ── chats (v3) ────────────────────────────────────────────────────
  // Written by `syncChats`, incrementally: unlike mail, chat messages are stored once in
  // `conversation_messages` and never rewritten wholesale, because a chat history is too large
  // to rebuild on every sync under gjsify's per-process execution budget (see `insertMany`).
  // What IS rebuilt is the link to the participant directory, in `rebuildConversations`:
  // `chat_peer_links` is derived, the other chat tables are not.

  // One peer (person, bot, channel) as the network reports it; `addresses_json` holds the
  // normalized addresses.
  `CREATE TABLE IF NOT EXISTS chat_peers (
     backend TEXT NOT NULL,
     account_id TEXT NOT NULL,
     peer_id TEXT NOT NULL,
     display_name TEXT,
     addresses_json TEXT,
     is_bot INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (backend, account_id, peer_id))`,

  // Which directory participant a chat peer resolved to — the address book first, so a peer
  // whose phone number is a contact's becomes that contact.
  `CREATE TABLE IF NOT EXISTS chat_peer_links (
     backend TEXT NOT NULL,
     account_id TEXT NOT NULL,
     peer_id TEXT NOT NULL,
     participant_id TEXT NOT NULL,
     PRIMARY KEY (backend, account_id, peer_id))`,

  `CREATE TABLE IF NOT EXISTS chat_members (
     conversation_id TEXT NOT NULL,
     backend TEXT NOT NULL,
     account_id TEXT NOT NULL,
     peer_id TEXT NOT NULL,
     PRIMARY KEY (conversation_id, peer_id))`,

  // The per-chat sync cursor. A row here is also what makes a conversation a CHAT to the
  // rebuild — the store tells the two apart by driver data, never by backend name.
  `CREATE TABLE IF NOT EXISTS chat_cursors (
     conversation_id TEXT PRIMARY KEY,
     backend TEXT NOT NULL,
     account_id TEXT NOT NULL,
     chat_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     last_seq INTEGER,
     read_inbox_seq INTEGER,
     read_outbox_seq INTEGER,
     last_sync_at TEXT)`,
];

/**
 * One upgrade step: a plain statement, or a column to add.
 *
 * Columns are declared, not written as `ALTER TABLE … ADD COLUMN`, so the step can check first:
 * a binary from before this check (v1 is released) rewrites `schema_version` back to its own
 * number when it opens a newer index, and the next newer binary then replays the upgrade
 * against columns that already exist. SQLite has no `ADD COLUMN IF NOT EXISTS`.
 */
type UpgradeStep = string | { table: string; column: string; type: string };

/**
 * Per-version upgrade steps, applied in order for a database below SCHEMA_VERSION.
 *
 * A fresh database runs them too (it starts at version 0), so a column is added HERE and never
 * in the `CREATE TABLE` above — declared in both places, the ALTER would fail on a new index.
 * Every step must be safe to run twice, for the reason given at `UpgradeStep`.
 */
const UPGRADES: Record<number, readonly UpgradeStep[]> = {
  // v2: what threading and classification read. Stored as fetched; the conversation tables
  // are derived from them.
  2: [
    { table: 'messages', column: 'in_reply_to', type: 'TEXT' },
    { table: 'messages', column: 'thread_refs', type: 'TEXT' },
    { table: 'messages', column: 'from_json', type: 'TEXT' },
    { table: 'messages', column: 'to_json', type: 'TEXT' },
    { table: 'messages', column: 'list_id', type: 'TEXT' },
    { table: 'messages', column: 'list_unsubscribe', type: 'TEXT' },
    { table: 'messages', column: 'auto_submitted', type: 'TEXT' },
    { table: 'messages', column: 'precedence', type: 'TEXT' },
    // Rows indexed under v1 lack all of the above. The index is derived (server archive), so
    // the honest fix is to fetch them again: resetting the cursors makes the next sync re-index
    // every folder, and `upsertMessage` replaces each row in place.
    'UPDATE folders SET last_uid = 0, uid_next = NULL, message_count = NULL',
  ],
  // v3: chat messages live in conversation_messages itself (mail keeps its body in the FTS
  // table and derives these rows; a chat has no other copy in the index).
  3: [
    { table: 'conversation_messages', column: 'body', type: 'TEXT' },
    { table: 'conversation_messages', column: 'remote_seq', type: 'INTEGER' },
    { table: 'conversation_messages', column: 'sender_peer_id', type: 'TEXT' },
    { table: 'conversation_messages', column: 'edited_at', type: 'TEXT' },
    { table: 'conversation_messages', column: 'reply_to_remote_id', type: 'TEXT' },
    { table: 'conversation_messages', column: 'thread_remote_id', type: 'TEXT' },
    { table: 'conversation_messages', column: 'peer_read', type: 'INTEGER' },
    `CREATE INDEX IF NOT EXISTS conversation_messages_seq ON conversation_messages (conversation_id, remote_seq)`,
  ],
  // v4: the archive's own id of the newest synced entry, for networks that page by id (XMPP
  // MAM) — the number in `last_seq` orders messages but cannot resume such an archive.
  4: [{ table: 'chat_cursors', column: 'last_cursor', type: 'TEXT' }],
  // v5: a read receipt that names no chat (a Signal `ReceiptMessage` carries sent timestamps and
  // nothing else) is applied by `remote_id`, so that lookup needs an index of its own.
  5: [
    `CREATE INDEX IF NOT EXISTS conversation_messages_remote ON conversation_messages (backend, account_id, remote_id)`,
  ],
  // v6: the receive lease (ADR 0002 §4) — one row per (backend, account) a running daemon is
  // receiving: the holder's pid, when it was last heard from, and WHEN IT EXPIRES. The expiry is
  // the holder's own (its heartbeat + 3 × its own refresh interval), so a taker never has to know
  // how often somebody else refreshes to judge that lease alive. A new table and nothing else: the
  // index is irreplaceable for a delivery-only account, and no upgrade here rewrites a stored row.
  // v7: what the delivery-only sync learned about a linked device. `link_dropped_at` is set when
  // the server stopped knowing the device and CLEARED when a later run reaches it again, so an
  // empty value means "not known to be dropped" rather than "never checked".
  7: [{ table: 'accounts', column: 'link_dropped_at', type: 'TEXT' }],
  6: [
    `CREATE TABLE IF NOT EXISTS receive_leases (
       backend TEXT NOT NULL,
       account_id TEXT NOT NULL,
       holder TEXT NOT NULL,
       heartbeat_at TEXT NOT NULL,
       expires_at TEXT NOT NULL,
       PRIMARY KEY (backend, account_id))`,
  ],
  // v8: how far the rotating deletion probe got in this chat (ADR 0004). A full scan asks the
  // network about the stored messages BELOW the window it re-read, a bounded slice at a time,
  // oldest first, and leaves the highest sequence it asked about here. NULL means "start at the
  // chat's oldest stored message again" — which is also what a finished sweep writes back, so
  // the probe keeps circling instead of stopping at the top.
  8: [{ table: 'chat_cursors', column: 'probe_seq', type: 'INTEGER' }],
  // v9: the id a reply POINTS AT, as the sender wrote it (XEP-0461 `<reply id>`). `reply_to_remote_id`
  // holds the resolved archive id; this one is what a caller's own sent id (`originId`) matches.
  9: [{ table: 'conversation_messages', column: 'reply_to_client_id', type: 'TEXT' }],
  // v10: the change journal (ADR 0007 §1) — what changed, never what it says. A new table and
  // nothing else, so no stored row is rewritten. Created here only, like `receive_leases`.
  10: [
    `CREATE TABLE IF NOT EXISTS index_changes (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       at TEXT NOT NULL,
       kind TEXT NOT NULL CHECK (kind IN ('messages', 'conversations', 'accounts')),
       backend TEXT,
       account_id TEXT,
       conversation_id TEXT)`,
  ],
  // v11: Delta Chat's open `Chat-Version: 1.0` marker. A thread counts as an email chat when any
  // message carries it, so an unmarked reply from an ordinary MUA stays in that conversation.
  // Older mail rows need one re-fetch to learn the marker; delivery-only chat rows are untouched.
  11: [
    { table: 'messages', column: 'email_chat', type: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'conversations', column: 'email_chat', type: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'conversation_messages', column: 'email_chat', type: 'INTEGER NOT NULL DEFAULT 0' },
    'UPDATE folders SET last_uid = 0, uid_next = NULL, message_count = NULL',
  ],
  // v12: remove the local echoes a send left beside the network's own copy of the same message.
  // A send routed through the daemon came back on the daemon's socket and was stored BEFORE the
  // sender recorded it, and the echo written then had nothing left to adopt it (`deliveredTwin`
  // in chat-sync.ts is the fix; this repairs what the bug already wrote). Conservative on
  // purpose: an echo goes only when its delivered twin is in the same backend, account AND
  // conversation, it hands its text over first when the twin has none, and a lonely echo —
  // a message the network never delivered back — is left alone. Then the chat aggregates, which
  // counted the duplicate.
  12: [
    `UPDATE conversation_messages SET body = (SELECT e.body FROM conversation_messages e
         WHERE e.backend = conversation_messages.backend
           AND e.account_id = conversation_messages.account_id
           AND e.conversation_id = conversation_messages.conversation_id
           AND e.remote_id = '${LOCAL_ECHO_PREFIX}' || conversation_messages.remote_id)
       WHERE (body IS NULL OR body = '')
         AND remote_id NOT LIKE '${LOCAL_ECHO_PREFIX}%'
         AND EXISTS (SELECT 1 FROM conversation_messages e
           WHERE e.backend = conversation_messages.backend
             AND e.account_id = conversation_messages.account_id
             AND e.conversation_id = conversation_messages.conversation_id
             AND e.remote_id = '${LOCAL_ECHO_PREFIX}' || conversation_messages.remote_id
             AND e.body IS NOT NULL AND e.body <> '')`,
    `DELETE FROM conversation_messages WHERE remote_id LIKE '${LOCAL_ECHO_PREFIX}%'
       AND EXISTS (SELECT 1 FROM conversation_messages d
         WHERE d.backend = conversation_messages.backend
           AND d.account_id = conversation_messages.account_id
           AND d.conversation_id = conversation_messages.conversation_id
           AND d.remote_id NOT LIKE '${LOCAL_ECHO_PREFIX}%'
           AND conversation_messages.remote_id = '${LOCAL_ECHO_PREFIX}' || d.remote_id)`,
    `UPDATE conversations SET
         message_count = (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = conversations.id),
         unread_count = (SELECT COUNT(*) FROM conversation_messages m
                          WHERE m.conversation_id = conversations.id AND m.from_self = 0 AND m.seen = 0),
         first_message_at = (SELECT MIN(sent_at) FROM conversation_messages m WHERE m.conversation_id = conversations.id),
         last_message_at = (SELECT MAX(sent_at) FROM conversation_messages m WHERE m.conversation_id = conversations.id),
         has_attachments = (SELECT COUNT(*) > 0 FROM conversation_messages m
                             WHERE m.conversation_id = conversations.id AND m.has_attachments = 1)
       WHERE id IN (SELECT conversation_id FROM chat_cursors)`,
  ],
  // v13: what a window needs to talk into a room and to recognise the chat with oneself, both
  // learned at sync time so the window never opens a secret. `accounts.address` is the account's
  // own address (never a key); the room columns are NULL until the network has said (a reader
  // must not read NULL as "private" or "unencrypted"). Nothing to re-fetch: the next sync fills
  // them, and an index that has not synced yet simply shows no hint.
  13: [
    { table: 'accounts', column: 'address', type: 'TEXT' },
    { table: 'chat_cursors', column: 'room_public', type: 'INTEGER' },
    { table: 'chat_cursors', column: 'room_encrypted', type: 'INTEGER' },
    { table: 'chat_cursors', column: 'room_members', type: 'INTEGER' },
  ],
  // v14: chat attachments across protocols (ADR 0010). A new table, no stored row rewritten.
  14: [
    `CREATE TABLE IF NOT EXISTS message_attachments (
       message_id TEXT NOT NULL,
       idx INTEGER NOT NULL,
       filename TEXT,
       mime_type TEXT,
       size INTEGER,
       kind TEXT,
       width INTEGER,
       height INTEGER,
       duration_ms INTEGER,
       handle TEXT,
       PRIMARY KEY (message_id, idx))`,
  ],
  // v15: the album a chat message belongs to (Telegram's grouped id). NULL = not looked at yet,
  // '' = looked, not part of one; a reader treats both as "no album".
  15: [{ table: 'conversation_messages', column: 'group_id', type: 'TEXT' }],
  // v16: the id the sender gave a chat message (XMPP's origin-id), which a reply to it names.
  // NULL for rows synced before; a full scan of the chat fills it in.
  16: [{ table: 'conversation_messages', column: 'client_id', type: 'TEXT' }],
};

function columnsOf(db: IndexDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((r) => String(r.name)));
}

function applyStep(db: IndexDatabase, step: UpgradeStep): void {
  if (typeof step === 'string') {
    db.exec(step);
    return;
  }
  if (columnsOf(db, step.table).has(step.column)) return;
  db.exec(`ALTER TABLE ${step.table} ADD COLUMN ${step.column} ${step.type}`);
}

/** Thrown when the index was written by a newer curlew than the one opening it. */
export class IndexTooNewError extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(
      `the index is schema version ${found}, but this curlew only knows up to ${supported} — ` +
        'update curlew (or point CURLEW_DB_PATH at another index); the index was left untouched',
    );
    this.name = 'IndexTooNewError';
    this.found = found;
    this.supported = supported;
  }
}

function readVersion(db: IndexDatabase): number {
  try {
    const row = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as
      | { value?: string }
      | undefined;
    return row?.value ? Number.parseInt(row.value, 10) : 0;
  } catch {
    // A database with no schema_meta at all is version 0. This is the ONE place a swallowed
    // error is the right answer, because "the table does not exist" IS the information wanted.
    return 0;
  }
}

/**
 * Create or upgrade the schema. Safe to call on every open.
 *
 * Refuses an index from a NEWER curlew and leaves it untouched: writing our own, lower
 * version into it would make the newer binary replay its upgrades on the next open.
 *
 * An index that is already current is NOT written to. Every command and the MCP server open the
 * index through here, so a write on each open would make a reader queue behind (or, before the
 * busy timeout, fail against) the daemon's batch. A real upgrade takes the write lock up front
 * and re-reads the version under it, because another process may have migrated while this one
 * waited.
 */
export function migrate(db: IndexDatabase): void {
  const seen = readVersion(db);
  if (seen > SCHEMA_VERSION) throw new IndexTooNewError(seen, SCHEMA_VERSION);
  if (seen === SCHEMA_VERSION) return;
  withTransaction(db, () => {
    const from = readVersion(db);
    if (from > SCHEMA_VERSION) throw new IndexTooNewError(from, SCHEMA_VERSION);
    if (from === SCHEMA_VERSION) return;
    for (const statement of STATEMENTS) db.exec(statement);
    for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
      for (const step of UPGRADES[v] ?? []) applyStep(db, step);
    }
    db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );
  });
}
