/**
 * The person's own read position (schema v26), kept apart from what the network says.
 *
 * `seen` on a message is the network's word (a chat read marker, mail `\Seen`) and a sync
 * rewrites it every time. What the person read in this window must survive that, so it lives in
 * `conversation_read_state`: `read_through` is the `sent_at` of the newest incoming message read
 * here, and a message is seen when the network says so OR it is not newer than that. A network
 * marker beyond the local one wins without any extra rule, because it only adds seen rows.
 * `marked_unread` keeps a conversation unread (count of at least one) until it is read again.
 */

import { appendChanges } from './changes.ts';
import { conversationTotalsSql } from './conversation-totals.ts';
import type { IndexDatabase, SqlValue } from './db.ts';
import { withTransaction } from './db.ts';

export interface LocalReadState {
  readThrough: string | null;
  markedUnread: boolean;
}

const time = (value: string): number => Date.parse(value);

/** Is `sentAt` not newer than the local read position? Mail dates are not always ISO, so parse first. */
export function readLocally(sentAt: string | null, readThrough: string | null): boolean {
  if (sentAt === null || readThrough === null) return false;
  const a = time(sentAt);
  const b = time(readThrough);
  if (Number.isNaN(a) || Number.isNaN(b)) return sentAt <= readThrough;
  return a <= b;
}

/** Every conversation with a local read state. */
export function loadLocalReadStates(db: IndexDatabase): Map<string, LocalReadState> {
  const rows = db
    .prepare('SELECT conversation_id, read_through, marked_unread FROM conversation_read_state')
    .all() as Array<Record<string, unknown>>;
  const out = new Map<string, LocalReadState>();
  for (const r of rows) {
    out.set(String(r.conversation_id), {
      readThrough: r.read_through === null || r.read_through === undefined ? null : String(r.read_through),
      markedUnread: Number(r.marked_unread) === 1,
    });
  }
  return out;
}

/**
 * Re-apply the local read position to the chat messages a sync just rewrote: incoming messages
 * inside `where` that the network still shows unread, but the person read here. Run it before
 * `conversationTotalsSql` so the unread count follows.
 */
export function applyLocalRead(db: IndexDatabase, where: string, params: SqlValue[]): void {
  db.prepare(
    `UPDATE conversation_messages SET seen = 1
      WHERE from_self = 0 AND seen = 0 AND (${where})
        AND sent_at <= (SELECT r.read_through FROM conversation_read_state r
                         WHERE r.conversation_id = conversation_messages.conversation_id)`,
  ).run(...params);
}

interface Header {
  backend: string;
  accountId: string;
}

function header(db: IndexDatabase, conversationId: string): Header | null {
  const row = db.prepare('SELECT backend, account_id FROM conversations WHERE id = ?').get(conversationId) as
    | Record<string, unknown>
    | undefined;
  return row === undefined ? null : { backend: String(row.backend), accountId: String(row.account_id) };
}

function newestIncoming(db: IndexDatabase, conversationId: string): string | null {
  const rows = db
    .prepare('SELECT sent_at FROM conversation_messages WHERE conversation_id = ? AND from_self = 0 AND sent_at IS NOT NULL')
    .all(conversationId) as Array<{ sent_at: unknown }>;
  let best: string | null = null;
  for (const r of rows) {
    const at = String(r.sent_at);
    if (best === null || !readLocally(at, best)) best = at;
  }
  return best;
}

function refresh(db: IndexDatabase, conversationId: string, head: Header): void {
  db.prepare(conversationTotalsSql('id = ?')).run(conversationId);
  appendChanges(db, [
    { kind: 'conversations', backend: head.backend, accountId: head.accountId, conversationId },
  ]);
}

/**
 * The person read the conversation: the local position moves to its newest incoming message,
 * a "marked unread" flag clears, the counts are refreshed and the change is journaled so a list
 * open in another process updates. Returns false for a conversation the index does not hold.
 */
export function markConversationRead(db: IndexDatabase, conversationId: string): boolean {
  return withTransaction(db, () => {
    const head = header(db, conversationId);
    if (head === null) return false;
    const through = newestIncoming(db, conversationId);
    const before = loadLocalReadState(db, conversationId);
    db.prepare(
      `INSERT OR REPLACE INTO conversation_read_state (conversation_id, read_through, marked_unread)
       VALUES (?, ?, 0)`,
    ).run(conversationId, through ?? before?.readThrough ?? null);
    db.prepare(
      'UPDATE conversation_messages SET seen = 1 WHERE conversation_id = ? AND from_self = 0 AND seen = 0',
    ).run(conversationId);
    refresh(db, conversationId, head);
    return true;
  });
}

/** Show the conversation as unread (at least one) until it is read again. */
export function markConversationUnread(db: IndexDatabase, conversationId: string): boolean {
  return withTransaction(db, () => {
    const head = header(db, conversationId);
    if (head === null) return false;
    const before = loadLocalReadState(db, conversationId);
    db.prepare(
      `INSERT OR REPLACE INTO conversation_read_state (conversation_id, read_through, marked_unread)
       VALUES (?, ?, 1)`,
    ).run(conversationId, before?.readThrough ?? null);
    refresh(db, conversationId, head);
    return true;
  });
}

export function loadLocalReadState(db: IndexDatabase, conversationId: string): LocalReadState | null {
  const row = db
    .prepare('SELECT read_through, marked_unread FROM conversation_read_state WHERE conversation_id = ?')
    .get(conversationId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    readThrough: row.read_through === null || row.read_through === undefined ? null : String(row.read_through),
    markedUnread: Number(row.marked_unread) === 1,
  };
}
