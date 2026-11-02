/**
 * The change journal (ADR 0007 §1): one row per "something changed here", written by the same
 * transaction that changed it. A row names a place — kind, backend, account, conversation — and
 * never carries content, so it may cross the session bus and a log line.
 *
 * Why a table and not a signal alone: a signal is lost on a reconnect, a journal can be read from
 * a cursor. `readChanges` tells a reader that fell behind (`afterSeq < oldest - 1`) so it re-reads
 * the state instead of trusting a gap.
 */

import type { IndexDatabase } from './db.ts';
import { insertMany, withTransaction } from './db.ts';

export type ChangeKind = 'messages' | 'conversations' | 'accounts';

/** What a writer reports. Absent fields are stored as NULL ("all of them"). */
export interface ChangeInput {
  kind: ChangeKind;
  backend?: string | null;
  accountId?: string | null;
  conversationId?: string | null;
}

export interface ChangeRow {
  seq: number;
  at: string;
  kind: ChangeKind;
  backend: string | null;
  accountId: string | null;
  conversationId: string | null;
}

export interface ChangeRead {
  changes: ChangeRow[];
  /** Smallest / largest seq in the journal; null when it is empty. */
  oldest: number | null;
  newest: number | null;
}

/** Rows kept regardless of age, and how long older ones are kept regardless of count. */
export const CHANGES_KEEP_ROWS = 10_000;
export const CHANGES_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Append a batch, one row per distinct (kind, backend, account, conversation), then prune.
 * Call it inside the transaction that made the change; an empty batch writes nothing.
 * A row survives the prune if it is among the newest `CHANGES_KEEP_ROWS` OR younger than 7 days.
 */
export function appendChanges(db: IndexDatabase, rows: readonly ChangeInput[], now: Date = new Date()): void {
  if (rows.length === 0) return;
  const seen = new Set<string>();
  const unique: ChangeInput[] = [];
  for (const row of rows) {
    const key = JSON.stringify([
      row.kind,
      row.backend ?? null,
      row.accountId ?? null,
      row.conversationId ?? null,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  const at = now.toISOString();
  insertMany(
    db,
    'INSERT INTO index_changes (at, kind, backend, account_id, conversation_id)',
    unique.map((r) => [at, r.kind, r.backend ?? null, r.accountId ?? null, r.conversationId ?? null]),
  );
  const newest = newestSeq(db);
  if (newest === null) return;
  db.prepare('DELETE FROM index_changes WHERE seq <= ? AND at < ?').run(
    newest - CHANGES_KEEP_ROWS,
    new Date(now.getTime() - CHANGES_KEEP_MS).toISOString(),
  );
}

/** `appendChanges` in a transaction of its own, for a writer that has none around the change. */
export function appendChangesTransaction(db: IndexDatabase, rows: readonly ChangeInput[], now?: Date): void {
  if (rows.length === 0) return;
  withTransaction(db, () => appendChanges(db, rows, now));
}

export function newestSeq(db: IndexDatabase): number | null {
  const row = db.prepare('SELECT MAX(seq) AS n FROM index_changes').get() as { n: number | null } | undefined;
  return row?.n === null || row?.n === undefined ? null : Number(row.n);
}

/** Journal rows after `afterSeq`, oldest first, at most `limit`. */
export function readChanges(db: IndexDatabase, afterSeq: number, limit = 500): ChangeRead {
  const found = db
    .prepare(
      `SELECT seq, at, kind, backend, account_id, conversation_id
         FROM index_changes WHERE seq > ? ORDER BY seq LIMIT ?`,
    )
    .all(afterSeq, limit) as Record<string, unknown>[];
  const bounds = db.prepare('SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM index_changes').get() as
    | { lo: number | null; hi: number | null }
    | undefined;
  const orNull = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    changes: found.map((r) => ({
      seq: Number(r.seq),
      at: String(r.at),
      kind: String(r.kind) as ChangeKind,
      backend: orNull(r.backend),
      accountId: orNull(r.account_id),
      conversationId: orNull(r.conversation_id),
    })),
    oldest: bounds?.lo === null || bounds?.lo === undefined ? null : Number(bounds.lo),
    newest: bounds?.hi === null || bounds?.hi === undefined ? null : Number(bounds.hi),
  };
}
