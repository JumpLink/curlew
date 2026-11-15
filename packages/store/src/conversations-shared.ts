/**
 * Helpers shared between the read/query and rebuild halves of the conversation store.
 */

import type { IndexDatabase } from './db.ts';

export const MAIL_BACKEND = 'mail';

export const PENDING_DELETE = 'pending-delete:';
export const PENDING_DELETE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Records the person's own reaction on a message once the network took it: their rows go, and
 * `emoji` (when not null) becomes the one. The network's own echo, if any, lands on the same key.
 */
export function setOwnReaction(db: IndexDatabase, messageId: string, emoji: string | null): void {
  db.prepare("DELETE FROM message_reactions WHERE message_id = ? AND reactor = ''").run(messageId);
  if (emoji === null) return;
  db.prepare("INSERT OR REPLACE INTO message_reactions (message_id, reactor, emoji) VALUES (?, '', ?)").run(
    messageId,
    emoji,
  );
}
