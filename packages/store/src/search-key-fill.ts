import type { IndexDatabase } from './db.ts';
import { searchKey } from './search-key.ts';

const FILL_CHUNK = 100;

/**
 * Compute `search_key` for every message row that lacks one. A write path that inserts or edits
 * a body leaves the column NULL (an `INSERT OR REPLACE` resets it, an edit sets it NULL) and
 * calls this at the end of its transaction, so a key is never stale and no insert statement has
 * to know about it. Idempotent; a row with neither subject nor body gets the empty key and is
 * not visited again. Returns how many rows it filled.
 */
export function fillSearchKeys(db: IndexDatabase, limit = Number.POSITIVE_INFINITY): number {
  let filled = 0;
  while (filled < limit) {
    const rows = db
      .prepare(`SELECT id, subject, body FROM conversation_messages WHERE search_key IS NULL LIMIT ${FILL_CHUNK}`)
      .all() as Array<{ id: string; subject: string | null; body: string | null }>;
    if (rows.length === 0) break;
    const cases = rows.map(() => 'WHEN ? THEN ?').join(' ');
    const params: string[] = [];
    for (const r of rows) params.push(r.id, searchKey(r.subject, r.body));
    db.prepare(
      `UPDATE conversation_messages SET search_key = CASE id ${cases} END WHERE id IN (${rows.map(() => '?').join(', ')})`,
    ).run(...params, ...rows.map((r) => r.id));
    filled += rows.length;
  }
  return filled;
}
