/**
 * Media thumbnails written at sync (ADR 0017). The bytes are a file under `thumbsDir()`, never a
 * column: the index is `state` and backed up, a thumbnail is `derived`. The index keeps only
 * `thumb_handle`, `thumb_state` and the network's own `blur_hash`.
 */

import { createHash } from 'node:crypto';
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttachmentKind, ChatAttachment, MessageRef } from '@curlew/protocol';

import type { IndexDatabase } from './db.ts';
import { placeholders, type SqlValue } from './db.ts';
import { thumbsDir } from './desktop-paths.ts';
import { ensurePrivateDir } from './download.ts';

/** Inline bytes above this are dropped, not re-encoded. */
export const THUMBNAIL_MAX_BYTES = 16 * 1024;

/**
 * A thumbnail fetched by its handle (ADR 0017 §2) may be this big. It is higher than the inline cap
 * on purpose: inline bytes ride in every message at sync, so a gallery of them must stay small, while
 * a fetched one is a single download of whatever size the network chose (Matrix and Telegram
 * thumbnails run to a few tens of KiB, sometimes more) and is only fetched when its bubble shows.
 */
export const THUMBNAIL_FETCH_MAX_BYTES = 256 * 1024;

/** A blurHash is at most this long (4x3 components take 28 characters). */
export const BLUR_HASH_MAX_CHARS = 40;

/** The three columns ADR 0017 adds, in the order {@link thumbnailColumns} returns them. */
export const THUMB_COLUMNS = 'thumb_handle, thumb_state, blur_hash';

export type ThumbState = 'none' | 'stored' | 'failed';

/** The file of one attachment's thumbnail. Keyed by the message row id and part index. */
export function thumbPath(messageId: string, index: number, root: string = thumbsDir()): string {
  const key = createHash('sha256').update(`${messageId}\u0000${index}`).digest('hex');
  return join(root, `${key}.jpg`);
}

/** The thumbnail's path when the row says it is stored AND the file is still there, else null. */
export function storedThumbPath(
  messageId: string,
  index: number,
  state: unknown,
  root: string = thumbsDir(),
): string | null {
  if (state !== 'stored') return null;
  const path = thumbPath(messageId, index, root);
  return existsSync(path) ? path : null;
}

/** A blurHash is base83; anything else (or too long) is not stored. */
export function cleanBlurHash(hash: string | undefined): string | null {
  if (!hash || hash.length < 6 || hash.length > BLUR_HASH_MAX_CHARS) return null;
  return /^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]+$/.test(hash) ? hash : null;
}

/**
 * The `[thumb_handle, thumb_state, blur_hash]` values for one attachment row. Inline bytes within
 * the cap are written to the thumbs directory right here (`'stored'`); a larger or empty blob is
 * dropped (`'none'`); a handle alone leaves the state NULL for the window to fetch.
 */
export function thumbnailColumns(
  messageId: string,
  index: number,
  attachment: Pick<ChatAttachment, 'thumbnail' | 'thumbHandle' | 'blurHash'>,
  root: string = thumbsDir(),
): [string | null, string | null, string | null] {
  const blur = cleanBlurHash(attachment.blurHash);
  const bytes = attachment.thumbnail;
  const handle = attachment.thumbHandle ? attachment.thumbHandle : null;
  if (bytes !== undefined) {
    if (bytes.length > 0 && bytes.length <= THUMBNAIL_MAX_BYTES) {
      try {
        ensurePrivateDir(root);
        writeFileSync(thumbPath(messageId, index, root), bytes, { mode: 0o600 });
        return [null, 'stored', blur];
      } catch {
        return [handle, 'failed', blur];
      }
    }
    if (handle === null) return [null, 'none', blur];
  }
  return [handle, null, blur];
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone: the goal.
  }
}

/** Delete the thumbnail files of the attachment rows matching `where`; call before deleting the rows. */
export function sweepThumbnails(
  db: IndexDatabase,
  where: string,
  params: readonly SqlValue[],
  root: string = thumbsDir(),
): void {
  const rows = db
    .prepare(`SELECT message_id, idx FROM message_attachments WHERE thumb_state = 'stored' AND ${where}`)
    .all(...params) as Array<{ message_id: unknown; idx: unknown }>;
  for (const r of rows) unlinkQuietly(thumbPath(String(r.message_id), Number(r.idx), root));
}

/** {@link sweepThumbnails} for a list of message ids, in chunks. */
export function sweepThumbnailsOf(db: IndexDatabase, messageIds: readonly string[], root: string = thumbsDir()): void {
  const chunk = 400;
  for (let i = 0; i < messageIds.length; i += chunk) {
    const part = messageIds.slice(i, i + chunk);
    sweepThumbnails(db, `message_id IN (${placeholders(part.length)})`, part, root);
  }
}

/** A message moved to a new row id (a chat merge): its thumbnail follows. */
export function moveThumbnail(
  oldId: string,
  newId: string,
  index: number,
  root: string = thumbsDir(),
): void {
  try {
    const from = thumbPath(oldId, index, root);
    if (!existsSync(from)) return;
    renameSync(from, thumbPath(newId, index, root));
  } catch {
    // A thumbnail that does not follow is a poster lost, not data.
  }
}

/** What the index knows to fetch one attachment's thumbnail: the handle never leaves store and daemon. */
export interface ThumbTarget {
  messageId: string;
  index: number;
  kind: AttachmentKind;
  /** Backend-private. */
  handle: string;
  state: string | null;
}

/**
 * The thumbnail handle of one chat attachment, or null when none is offered, the thumbnail is
 * already stored, or it is `'none'`. A `'failed'` row is a target again: the caller limits retries.
 */
export function loadThumbTarget(db: IndexDatabase, ref: MessageRef, index: number): ThumbTarget | null {
  if (ref.backend === 'mail' || !ref.remoteId) return null;
  const row = db
    .prepare(
      `SELECT a.message_id, a.kind, a.thumb_handle, a.thumb_state FROM message_attachments a
         JOIN conversation_messages m ON m.id = a.message_id
        WHERE m.backend = ? AND m.account_id = ? AND m.remote_id = ? AND a.idx = ?`,
    )
    .get(ref.backend, ref.accountId, ref.remoteId, index) as
    | { message_id?: unknown; kind?: unknown; thumb_handle?: unknown; thumb_state?: unknown }
    | undefined;
  if (typeof row?.thumb_handle !== 'string' || row.thumb_handle === '') return null;
  const state = typeof row.thumb_state === 'string' ? row.thumb_state : null;
  if (state === 'stored' || state === 'none') return null;
  return {
    messageId: String(row.message_id),
    index,
    kind: (typeof row.kind === 'string' ? row.kind : 'image') as AttachmentKind,
    handle: row.thumb_handle,
    state,
  };
}

/** Record how a thumbnail fetch ended. */
export function setThumbState(db: IndexDatabase, messageId: string, index: number, state: ThumbState): void {
  db.prepare('UPDATE message_attachments SET thumb_state = ? WHERE message_id = ? AND idx = ?').run(
    state,
    messageId,
    index,
  );
}
