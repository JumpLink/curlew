/**
 * Deleting what the index holds for ONE account: the second half of "remove account".
 *
 * The store knows tables, not backends (ADR 0001 §5): the caller names the backend and the account
 * id, and every row keyed by that pair goes — in one transaction, so a crash leaves the account
 * whole or gone. Other accounts are never touched; a participant that another account's chat still
 * uses stays.
 */

import { appendChanges } from './changes.ts';
import { type IndexDatabase, withTransaction } from './db.ts';

export interface AccountDataRemoved {
  /** Chat or mail messages deleted (both tables). */
  messages: number;
  conversations: number;
}

const count = (db: IndexDatabase, sql: string, ...params: string[]): number => {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return Number(row?.n ?? 0);
};

/**
 * Delete every indexed row of one account. `backend` is the backend that owns the conversation
 * rows; the mail tables (`messages`, `folders`, FTS) are keyed by the account id alone and are
 * only touched when `backend` is `mail`, because only mail writes them.
 */
export function deleteAccountData(db: IndexDatabase, backend: string, accountId: string): AccountDataRemoved {
  return withTransaction(db, () => {
    const convs = `SELECT id FROM conversations WHERE backend = ? AND account_id = ?`;
    const msgs = `SELECT id FROM conversation_messages WHERE backend = ? AND account_id = ?`;
    const conversations = count(
      db,
      'SELECT COUNT(*) AS n FROM conversations WHERE backend = ? AND account_id = ?',
      backend,
      accountId,
    );
    let messages = count(
      db,
      'SELECT COUNT(*) AS n FROM conversation_messages WHERE backend = ? AND account_id = ?',
      backend,
      accountId,
    );

    db.prepare(`DELETE FROM message_attachments WHERE message_id IN (${msgs})`).run(backend, accountId);
    db.prepare(`DELETE FROM message_reactions WHERE message_id IN (${msgs})`).run(backend, accountId);
    db.prepare('DELETE FROM conversation_messages WHERE backend = ? AND account_id = ?').run(backend, accountId);
    for (const table of ['conversation_participants', 'chat_members', 'chat_cursors']) {
      db.prepare(`DELETE FROM ${table} WHERE conversation_id IN (${convs})`).run(backend, accountId);
    }
    db.prepare('DELETE FROM conversations WHERE backend = ? AND account_id = ?').run(backend, accountId);
    for (const table of ['chat_peers', 'chat_peer_links', 'chat_members', 'chat_cursors', 'receive_leases']) {
      db.prepare(`DELETE FROM ${table} WHERE backend = ? AND account_id = ?`).run(backend, accountId);
    }

    if (backend === 'mail') {
      const owned = 'SELECT id FROM messages WHERE account_id = ?';
      messages += count(db, 'SELECT COUNT(*) AS n FROM messages WHERE account_id = ?', accountId);
      db.prepare(`DELETE FROM messages_fts WHERE rowid IN (${owned})`).run(accountId);
      db.prepare(`DELETE FROM attachments WHERE message_id IN (${owned})`).run(accountId);
      db.prepare('DELETE FROM messages WHERE account_id = ?').run(accountId);
      db.prepare('DELETE FROM folders WHERE account_id = ?').run(accountId);
      db.prepare('DELETE FROM sync_log WHERE account_id = ?').run(accountId);
    }
    db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);

    // Participants only this account knew: a contact-linked one belongs to the address book.
    const unused = `SELECT id FROM participants WHERE contact_uid IS NULL
        AND id NOT IN (SELECT participant_id FROM conversation_participants)
        AND id NOT IN (SELECT participant_id FROM chat_peer_links)`;
    db.prepare(`DELETE FROM participant_addresses WHERE participant_id IN (${unused})`).run();
    db.prepare(`DELETE FROM participants WHERE id IN (${unused})`).run();

    appendChanges(db, [
      { kind: 'accounts', backend, accountId },
      { kind: 'conversations', backend, accountId },
      { kind: 'messages', backend, accountId },
    ]);
    return { messages, conversations };
  });
}
