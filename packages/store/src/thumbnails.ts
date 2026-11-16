/**
 * Media thumbnails written at sync (ADR 0017). The bytes are a file under `thumbsDir()`, never a
 * column: the index is `state` and backed up, a thumbnail is `derived`. The index keeps only
 * `thumb_handle`, `thumb_state` and the network's own `blur_hash`.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatAttachment } from '@curlew/protocol';

import type { IndexDatabase } from './db.ts';
import { placeholders, type SqlValue } from './db.ts';
import { thumbsDir } from './desktop-paths.ts';
import { ensurePrivateDir } from './download.ts';

/** Inline bytes above this are dropped, not re-encoded. */
export const THUMBNAIL_MAX_BYTES = 16 * 1024;

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
    copyFileSync(from, thumbPath(newId, index, root));
  } catch {
    // A thumbnail that does not follow is a poster lost, not data.
  }
}
