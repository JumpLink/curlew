/**
 * Which Delta Chat messages the person has opened that still wait for our read receipt.
 *
 * Curlew reads mail with PEEK and never sets `\Seen`, so `messages.seen = 1` means another client
 * already showed the message (and sent its own receipt). `mail_receipts_sent` stops a second one.
 */

import { normalizeAddress } from '@curlew/protocol';
import type { IndexDatabase } from './db.ts';

/** At most this many receipts per opened conversation: an old backlog must not flood the peer. */
const MAX_PENDING = 50;

export interface PendingReadReceipt {
  accountId: string;
  /** The address that asked for the receipt. */
  to: string;
  /** The Message-ID being confirmed. */
  messageId: string;
}

/**
 * Messages of one conversation that asked for a receipt (`Chat-Disposition-Notification-To`) and
 * that we have not confirmed. A request whose address differs from the sender's is dropped: it asks
 * for a confirmation to go to a third party.
 */
export function pendingReadReceipts(db: IndexDatabase, conversationId: string): PendingReadReceipt[] {
  const rows = db
    .prepare(
      `SELECT m.account_id, m.message_id, m.receipt_to, m.from_json
         FROM conversation_messages c
         JOIN messages m ON m.account_id = c.account_id AND m.folder_path = c.folder_path AND m.uid = c.uid
        WHERE c.conversation_id = ? AND c.backend = 'mail' AND c.from_self = 0 AND c.email_chat = 1
          AND m.receipt_to IS NOT NULL AND m.message_id IS NOT NULL AND m.seen = 0 AND m.mdn = 0
          AND NOT EXISTS (SELECT 1 FROM mail_receipts_sent s
                           WHERE s.account_id = m.account_id AND s.message_id = m.message_id)
        ORDER BY c.sent_at DESC`,
    )
    .all(conversationId) as Array<Record<string, unknown>>;
  const result: PendingReadReceipt[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const to = normalizeAddress('email', String(r.receipt_to));
    let sender: string | null = null;
    try {
      const from = JSON.parse(String(r.from_json ?? '[]')) as Array<{ email?: string }>;
      sender = normalizeAddress('email', from[0]?.email ?? '');
    } catch {
      sender = null;
    }
    if (to === null || to !== sender) continue;
    const key = `${String(r.account_id)}\u0000${String(r.message_id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ accountId: String(r.account_id), to, messageId: String(r.message_id) });
    if (result.length >= MAX_PENDING) break;
  }
  return result;
}

/** Remember that the receipt for this message went out. */
export function markReceiptSent(db: IndexDatabase, accountId: string, messageId: string, at = Date.now()): void {
  db.prepare('INSERT OR IGNORE INTO mail_receipts_sent (account_id, message_id, sent_at) VALUES (?, ?, ?)').run(
    accountId,
    messageId,
    at,
  );
}
