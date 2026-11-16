/**
 * What becomes of a local echo's attachment rows when the network's own copy replaces it.
 *
 * The delivered copy's rows win when it has some; otherwise the echo's are kept (with their
 * thumbnails); a NULL size, width, height or duration in a delivered row is filled from the echo
 * row with the same index.
 */

import type { IndexDatabase } from './db.ts';
import type { SqlValue } from './db.ts';
import { moveThumbnail } from './thumbnails.ts';

const COLUMNS = `message_id, idx, filename, mime_type, size, kind, width, height, duration_ms, handle, thumb_handle, thumb_state, blur_hash`;
const IDX = 1;
const FILL = [4, 6, 7, 8] as const;
const THUMB_STATE = 11;

/**
 * Apply the rule to `rows`, the batch's not yet written attachment rows. Returns true when the
 * echo's rows were kept, so the caller marks the message as having attachments.
 */
export function adoptEchoAttachments(
  db: IndexDatabase,
  echoId: string,
  newId: string,
  rows: SqlValue[][],
): boolean {
  const echo = db
    .prepare(`SELECT ${COLUMNS} FROM message_attachments WHERE message_id = ? ORDER BY idx`)
    .all(echoId) as Array<Record<string, SqlValue>>;
  if (echo.length === 0) return false;
  const asRow = (r: Record<string, SqlValue>): SqlValue[] => COLUMNS.split(', ').map((c) => r[c] ?? null);
  const mine = rows.filter((r) => r[0] === newId);
  let kept = false;
  if (mine.length === 0) {
    for (const r of echo) {
      const row = asRow(r);
      row[0] = newId;
      rows.push(row);
      if (row[THUMB_STATE] === 'stored') moveThumbnail(echoId, newId, Number(row[IDX]));
    }
    kept = true;
  } else {
    for (const row of mine) {
      const twin = echo.find((r) => Number(r.idx) === Number(row[IDX]));
      if (!twin) continue;
      const source = asRow(twin);
      for (const i of FILL) if (row[i] === null || row[i] === undefined) row[i] = source[i];
      if (row[THUMB_STATE] !== 'stored' && source[THUMB_STATE] === 'stored') {
        moveThumbnail(echoId, newId, Number(row[IDX]));
        row[10] = source[10];
        row[THUMB_STATE] = 'stored';
        row[12] = row[12] ?? source[12];
      }
    }
  }
  db.prepare('DELETE FROM message_attachments WHERE message_id = ?').run(echoId);
  return kept;
}
