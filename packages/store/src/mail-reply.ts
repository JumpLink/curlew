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
