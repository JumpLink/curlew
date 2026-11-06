/** Resolve the RFC 5322 parent of a chat reply without denormalising it into every message DTO. */

import type { MessageRef } from '@curlew/protocol';
import type { IndexDatabase } from './db.ts';

export interface MailReplyTarget {
  messageId: string | null;
  references: string[];
}

export function mailReplyTarget(db: IndexDatabase, ref: MessageRef): MailReplyTarget | null {
  if (!ref.folder || ref.uid === undefined) return null;
  const row = db
    .prepare('SELECT message_id, thread_refs FROM messages WHERE account_id = ? AND folder_path = ? AND uid = ?')
    .get(ref.accountId, ref.folder, ref.uid) as { message_id?: unknown; thread_refs?: unknown } | undefined;
  if (!row) return null;
  return {
    messageId: typeof row.message_id === 'string' && row.message_id ? row.message_id : null,
    references: typeof row.thread_refs === 'string' ? row.thread_refs.split(' ').filter(Boolean) : [],
  };
}

export interface MailAttachmentInfo {
  filename: string | null;
  mimeType: string | null;
  size: number | null;
}

/** What the index knows about a mail message's attachments; chat backends keep only a flag. */
export function mailAttachments(db: IndexDatabase, ref: MessageRef): MailAttachmentInfo[] {
  if (!ref.folder || ref.uid === undefined) return [];
  const rows = db
    .prepare(
      `SELECT a.filename, a.mime_type, a.size FROM attachments a
         JOIN messages m ON m.id = a.message_id
        WHERE m.account_id = ? AND m.folder_path = ? AND m.uid = ? ORDER BY a.section`,
    )
    .all(ref.accountId, ref.folder, ref.uid) as Array<{ filename: unknown; mime_type: unknown; size: unknown }>;
  return rows.map((r) => ({
    filename: typeof r.filename === 'string' && r.filename.trim() ? r.filename.trim() : null,
    mimeType: typeof r.mime_type === 'string' && r.mime_type ? r.mime_type : null,
    size: r.size === null || r.size === undefined ? null : Number(r.size),
  }));
}
