/**
 * Attachment descriptors for chat messages stored before the index kept them (ADR 0010).
 *
 * Such a message says it has an attachment (`has_attachments`) but has no `message_attachments`
 * row, so the window can only show a blank "Attachment" tile and cannot fetch it. The engine walks
 * the chat's history forward from the oldest such message and writes only the descriptors — the
 * message rows are never touched, so a read marker or an edit stays as it is. The one exception is
 * `group_id`, for a network that groups media into albums: it is filled in for messages stored
 * before the column existed, `''` meaning "looked, not part of an album".
 *
 * Bounded per run, and it needs no progress state: a message that got a row leaves the candidate
 * set, so the next run starts where this one stopped. A message the network no longer shows with
 * an attachment gets a placeholder row (no handle), which also takes it out of the set; the tile
 * then says "Attachment" and offers no download, which is all that is known.
 *
 * ADR 0017 §7 adds a second kind of candidate: a message that already has descriptor rows but whose
 * image or video was stored before thumbnails (`thumb_state` and `thumb_handle` both NULL). The walk
 * fills in the thumbnail columns of those rows; a row the network gives no thumbnail for becomes
 * `'none'`, which takes it out of the set.
 */

import { isChatRateLimitedError } from '@curlew/protocol';
import type { ChatSession } from '@curlew/protocol';
import { appendChanges } from './changes.ts';
import type { IndexDatabase, SqlValue } from './db.ts';
import { insertMany, withTransaction } from './db.ts';
import { thumbnailColumns } from './thumbnails.ts';

/** Chats walked in one run, newest attachment first. */
export const BACKFILL_CHATS = 10;
/** History pages walked per chat in one run. */
export const BACKFILL_PAGES = 5;
const PAGE = 100;

interface Candidate {
  id: string;
  conversationId: string;
  remoteId: string;
  seq: number;
  chatId: string;
  /** It already has descriptor rows: only its album is missing. */
  described: boolean;
  /** An image or video row of it has no thumbnail state yet. */
  needsThumb: boolean;
}

function candidates(
  db: IndexDatabase,
  backend: string,
  accountId: string,
  groups: boolean,
): Map<string, Candidate[]> {
  const rows = db
    .prepare(
      `SELECT m.id, m.conversation_id, m.remote_id, m.remote_seq, c.chat_id,
              EXISTS (SELECT 1 FROM message_attachments a WHERE a.message_id = m.id) AS described,
              EXISTS (SELECT 1 FROM message_attachments a WHERE a.message_id = m.id
                         AND a.kind IN ('image', 'video')
                         AND a.thumb_state IS NULL AND a.thumb_handle IS NULL) AS needs_thumb
         FROM conversation_messages m
         JOIN chat_cursors c ON c.conversation_id = m.conversation_id
        WHERE m.backend = ? AND m.account_id = ? AND m.has_attachments = 1
          AND m.remote_id IS NOT NULL AND m.remote_seq IS NOT NULL
          AND (NOT EXISTS (SELECT 1 FROM message_attachments a WHERE a.message_id = m.id)
               OR EXISTS (SELECT 1 FROM message_attachments a WHERE a.message_id = m.id
                            AND a.kind IN ('image', 'video')
                            AND a.thumb_state IS NULL AND a.thumb_handle IS NULL)${
            groups ? ' OR m.group_id IS NULL' : ''
          })
        ORDER BY m.sent_at DESC`,
    )
    .all(backend, accountId) as Array<Record<string, unknown>>;
  const byChat = new Map<string, Candidate[]>();
  for (const r of rows) {
    const conversationId = String(r.conversation_id);
    const list = byChat.get(conversationId) ?? [];
    list.push({
      id: String(r.id),
      conversationId,
      remoteId: String(r.remote_id),
      seq: Number(r.remote_seq),
      chatId: String(r.chat_id),
      described: Number(r.described) === 1,
      needsThumb: Number(r.needs_thumb) === 1,
    });
    byChat.set(conversationId, list);
  }
  for (const list of byChat.values()) list.sort((a, b) => a.seq - b.seq);
  return byChat;
}

/**
 * Describe the attachments of already stored messages. Returns how many messages got a
 * descriptor row. A failure goes to `onError`; a rate limit also ends the run.
 */
export async function backfillAttachments(
  db: IndexDatabase,
  session: ChatSession,
  backend: string,
  accountId: string,
  onError: (err: unknown) => void,
): Promise<number> {
  if (!session.rewindable) return 0;
  let described = 0;
  const groups = session.groupsMedia === true;
  const chats = [...candidates(db, backend, accountId, groups).values()].slice(0, BACKFILL_CHATS);
  for (const pending of chats) {
    const byRemote = new Map(pending.map((c) => [c.remoteId, c]));
    const rows: SqlValue[][] = [];
    const done = new Set<string>();
    const thumbRows: SqlValue[][] = [];
    const thumbDone = new Set<string>();
    const groupRows: SqlValue[][] = [];
    const grouped = new Set<string>();
    let after = pending[0].seq - 1;
    let covered = after;
    let stop = false;
    try {
      for (let page = 0; page < BACKFILL_PAGES && covered < pending[pending.length - 1].seq; page++) {
        const found = await session.fetchHistory(pending[0].chatId, after, PAGE);
        for (const m of found.messages) {
          const stored = byRemote.get(m.remoteId);
          if (!stored) continue;
          if (groups && !grouped.has(stored.id)) {
            grouped.add(stored.id);
            groupRows.push([m.groupId ?? '', stored.id]);
          }
          if (stored.described && stored.needsThumb && !thumbDone.has(stored.id)) {
            thumbDone.add(stored.id);
            for (let i = 0; i < (m.attachments?.length ?? 0); i++) {
              const [handle, state, blur] = thumbnailColumns(stored.id, i, m.attachments![i]);
              thumbRows.push([handle, state ?? (handle === null ? 'none' : null), blur, stored.id, i]);
            }
          }
          if (stored.described || done.has(stored.id)) continue;
          for (let i = 0; i < (m.attachments?.length ?? 0); i++) {
            const a = m.attachments![i];
            rows.push([
              stored.id, i, a.filename, a.mimeType, a.size, a.kind, a.width, a.height, a.durationMs, a.handle,
              ...thumbnailColumns(stored.id, i, a),
            ]);
            done.add(stored.id);
          }
        }
        if (found.highestSeq === null || found.highestSeq <= after) {
          // Nothing newer: the whole rest of the chat is covered.
          covered = Number.POSITIVE_INFINITY;
          break;
        }
        after = covered = found.highestSeq;
        if (found.exhausted && found.messages.length === 0) covered = Number.POSITIVE_INFINITY;
      }
    } catch (err) {
      onError(err);
      stop = isChatRateLimitedError(err);
    }
    // A described row the walk passed without a thumbnail for: the network has none to offer.
    for (const c of pending) {
      if (c.needsThumb && c.seq <= covered && !thumbDone.has(c.id)) {
        thumbDone.add(c.id);
        thumbRows.push([null, 'none', null, c.id, -1]);
      }
    }
    // What the walk passed without finding an attachment on it: the network no longer has one.
    for (const c of pending) {
      if (c.seq > covered) continue;
      if (!c.described && !done.has(c.id)) {
        rows.push([c.id, 0, null, null, null, 'file', null, null, null, '', null, null, null]);
        done.add(c.id);
      }
      if (groups && !grouped.has(c.id)) {
        grouped.add(c.id);
        groupRows.push(['', c.id]);
      }
    }
    if (rows.length > 0 || groupRows.length > 0 || thumbRows.length > 0) {
      withTransaction(db, () => {
        if (rows.length > 0) insertMany(
          db,
          `INSERT OR IGNORE INTO message_attachments
             (message_id, idx, filename, mime_type, size, kind, width, height, duration_ms, handle, thumb_handle, thumb_state, blur_hash)`,
          rows,
        );
        for (const [handle, state, blur, id, idx] of thumbRows) {
          // `idx` -1: every thumbnail-less image or video row of the message.
          db.prepare(
            `UPDATE message_attachments SET thumb_handle = ?, thumb_state = ?, blur_hash = COALESCE(?, blur_hash)
              WHERE message_id = ? AND thumb_state IS NULL AND thumb_handle IS NULL
                AND kind IN ('image', 'video') AND (? = -1 OR idx = ?)`,
          ).run(handle, state, blur, id, idx, idx);
        }
        for (const [group, id] of groupRows) {
          db.prepare('UPDATE conversation_messages SET group_id = ? WHERE id = ?').run(group, id);
        }
        appendChanges(db, [{ kind: 'messages', backend, accountId, conversationId: pending[0].conversationId }]);
      });
      described += done.size + thumbDone.size;
    }
    if (stop) break;
  }
  return described;
}
