/**
 * Opening the SQLite index through the built-in `node:sqlite`.
 *
 * Under GJS that module is supplied by gjsify's `@gjsify/sqlite`, so the same `DatabaseSync`
 * code runs on both runtimes. It is NOT a sqlite3 binding, though — it is a **libgda** wrapper,
 * and that leaks through in four ways which shape every query in this package. Read
 * `AGENTS.md` in this directory before writing SQL here.
 */

import { DatabaseSync } from 'node:sqlite';

export type IndexDatabase = DatabaseSync;

/**
 * How long a statement waits for another process's write lock before it fails with
 * `database is locked`.
 *
 * Set on EVERY connection because the default is no wait at all on Node and an unrelated one on
 * GJS (libgda). The index has one long-lived writer (the daemon) and several short-lived
 * processes (`curlew sync`, the MCP server, a restarted daemon); a batch is milliseconds and the
 * conversation rebuild a few seconds, so this is generous. On GJS the effective wait is about 12
 * times the value (measured on GJS 1.88.1 / gjsify 0.59.1: 300 -> 3.6 s, 1000 -> 12 s), so a
 * stuck holder still fails in well under a minute.
 */
export const INDEX_BUSY_TIMEOUT_MS = 3_000;

export interface OpenIndexOptions {
  /** Overrides `INDEX_BUSY_TIMEOUT_MS`; tests use a short one. */
  busyTimeoutMs?: number;
}

/**
 * Open (and create) the index database.
 *
 * The path must end in `.db` — libgda appends the suffix itself, so `index.sqlite` becomes
 * `index.sqlite.db` on disk. `indexDbPath()` enforces that; this is the second line.
 */
export function openIndexDb(path: string, options: OpenIndexOptions = {}): DatabaseSync {
  if (path !== ':memory:' && !path.endsWith('.db')) {
    throw new Error(`index path must end in .db (libgda appends it): ${path}`);
  }
  const db = new DatabaseSync(path, { timeout: options.busyTimeoutMs ?? INDEX_BUSY_TIMEOUT_MS });
  // One statement per exec(): gjsify's wrapper splits multi-statement strings itself and its
  // splitter is not a SQL parser. WAL is a no-op for in-memory databases.
  if (path !== ':memory:' && !isWal(db)) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * WAL is stored in the file, so it only has to be switched on once. Asking first keeps every
 * later open — a reader's included — from issuing the mode change, which takes a lock.
 */
function isWal(db: DatabaseSync): boolean {
  const row = db.prepare('PRAGMA journal_mode').get() as Record<string, unknown> | undefined;
  return String(row?.journal_mode ?? '').toLowerCase() === 'wal';
}

/**
 * Run `fn` inside a transaction, rolling back on throw.
 *
 * `immediate` opens it with `BEGIN IMMEDIATE`, taking the write lock up front. That matters only
 * where two PROCESSES read-then-write the same row: a deferred `BEGIN` takes a read lock, and
 * SQLite does **not** run the busy handler when such a transaction later upgrades to a write
 * (SQLITE_BUSY_SNAPSHOT) — it fails at once, however long `busy_timeout` is. The receive lease is
 * exactly that read-then-write (`receive-lease.ts`); everything else in this package is
 * single-process, and stays deferred.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T, options: { immediate?: boolean } = {}): T {
  db.exec(options.immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Verify that FTS5 actually works, by round-tripping a known row through a scratch table.
 *
 * This exists because of the single most dangerous property of the wrapper: `all()` and `get()`
 * SWALLOW exceptions and return `[]`. A missing FTS5 module, a rejected tokenizer, or a
 * malformed MATCH therefore does not raise — the index simply answers "no results" to
 * everything, forever, and looks like an empty mailbox rather than a broken build.
 *
 * Called once at open time so that failure is LOUD and immediate. The scratch table lives in the
 * connection's TEMP schema: this runs on every open, readers' included, and a table in the main
 * file would take the write lock each time.
 */
export function probeFts5(db: DatabaseSync): void {
  db.exec('DROP TABLE IF EXISTS temp.fts_probe');
  try {
    db.exec(`CREATE VIRTUAL TABLE temp.fts_probe USING fts5(body, tokenize="unicode61 remove_diacritics 2")`);
  } catch (err) {
    throw new Error(
      `SQLite has no working FTS5 module, so the index cannot be searched: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  try {
    db.prepare('INSERT INTO temp.fts_probe(rowid, body) VALUES (?, ?)').run(1, 'Energieberatung März');
    const hit = db.prepare('SELECT rowid FROM temp.fts_probe WHERE fts_probe MATCH ?').all('"Energieberatung"');
    if (hit.length !== 1) throw new Error('a known row did not match its own text');
    // Diacritic folding is what makes "marz" find "März"; without it the tokenizer silently
    // gives a worse index rather than an error.
    const folded = db.prepare('SELECT rowid FROM temp.fts_probe WHERE fts_probe MATCH ?').all('"marz"');
    if (folded.length !== 1) throw new Error('the unicode61 remove_diacritics tokenizer is not active');
  } finally {
    db.exec('DROP TABLE IF EXISTS temp.fts_probe');
  }
}

export type SqlValue = string | number | null;

/** `?, ?, …` — n positional placeholders. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * Bound values per multi-row INSERT. Measured, not guessed: gjsify's libgda wrapper re-parses
 * the statement per execution at a cost that grows roughly with the square of its parameter
 * count, while each execution has a fixed cost of its own. Rebuilding 3 000 conversations on
 * GJS took 23 s one row per statement, 9.4 s at 20 values, 3.7 s at 60, 4.9 s at 150 and
 * 10.3 s at 400. 120 is a little slower than the optimum and spends half the executions,
 * which are the scarcer resource (see `insertMany`).
 */
export const PARAM_BUDGET = 120;

/**
 * `head VALUES (?, …), (?, …), …` in chunks of `budget` bound values. Every row must have the
 * same width. Call inside a transaction.
 *
 * Bulk writes go through here rather than one `run()` per row for SPEED, which is what
 * `PARAM_BUDGET` was measured for. The hard reason is gone: libgda used to cache every executed
 * statement per connection, each holding a GWeakRef on the SQLite provider that the whole PROCESS
 * shares (GLib caps those at 65 535), so past ~16 000 one-row `run()`s every SELECT — on any
 * connection, a fresh one included — came back empty. gjsify#1838 releases that state per
 * execution, and reads after 20 000 writes are pinned by a test in this repo.
 *
 * So this is now an optimisation, not a workaround, and it stays on its own merits: re-parsing
 * one statement with 120 bound values costs less than parsing 120 statements.
 */
export function insertMany(
  db: DatabaseSync,
  head: string,
  rows: readonly SqlValue[][],
  budget = PARAM_BUDGET,
): void {
  if (rows.length === 0) return;
  const perChunk = Math.max(1, Math.floor(budget / rows[0].length));
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const tuple = `(${placeholders(chunk[0].length)})`;
    db.prepare(`${head} VALUES ${chunk.map(() => tuple).join(', ')}`).run(...chunk.flat());
  }
}

/**
 * A sequence column as a SELECT expression, under a short name.
 *
 * Not a size workaround any more: gjsify#1841 reads an INTEGER column exactly, so a millisecond
 * timestamp — XMPP's archive order — comes back as the Number it is instead of emptying the
 * result. The alias stays because a value read as `col` out of a row joins two tables in the same
 * statement, and because the queries that sort by one qualify the column in `ORDER BY` (an
 * unqualified `ORDER BY` would pick up the alias, which for a bare column is the same thing).
 */
export const seqColumn = (column: string): string => `${column} AS ${column.replace(/^.*\./, '')}`;
