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
 * Open (and create) the index database.
 *
 * The path must end in `.db` — libgda appends the suffix itself, so `index.sqlite` becomes
 * `index.sqlite.db` on disk. `indexDbPath()` enforces that; this is the second line.
 */
export function openIndexDb(path: string): DatabaseSync {
  if (path !== ':memory:' && !path.endsWith('.db')) {
    throw new Error(`index path must end in .db (libgda appends it): ${path}`);
  }
  const db = new DatabaseSync(path);
  // One statement per exec(): gjsify's wrapper splits multi-statement strings itself and its
  // splitter is not a SQL parser. WAL is a no-op for in-memory databases.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
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
 * Called once at open time so that failure is LOUD and immediate.
 */
export function probeFts5(db: DatabaseSync): void {
  db.exec('DROP TABLE IF EXISTS fts_probe');
  try {
    db.exec(`CREATE VIRTUAL TABLE fts_probe USING fts5(body, tokenize="unicode61 remove_diacritics 2")`);
  } catch (err) {
    throw new Error(
      `SQLite has no working FTS5 module, so the index cannot be searched: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  try {
    db.prepare('INSERT INTO fts_probe(rowid, body) VALUES (?, ?)').run(1, 'Energieberatung März');
    const hit = db.prepare('SELECT rowid FROM fts_probe WHERE fts_probe MATCH ?').all('"Energieberatung"');
    if (hit.length !== 1) throw new Error('a known row did not match its own text');
    // Diacritic folding is what makes "marz" find "März"; without it the tokenizer silently
    // gives a worse index rather than an error.
    const folded = db.prepare('SELECT rowid FROM fts_probe WHERE fts_probe MATCH ?').all('"marz"');
    if (folded.length !== 1) throw new Error('the unicode61 remove_diacritics tokenizer is not active');
  } finally {
    db.exec('DROP TABLE IF EXISTS fts_probe');
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
 * Bulk writes go through here rather than one `run()` per row. That was forced by a gjsify gap:
 * libgda cached every executed statement per connection, each holding a GWeakRef on the SQLite
 * provider, and that provider is shared by the whole PROCESS (GLib caps it at 65 535). A `run()`
 * cost ~4 refs, so past ~16 000 of them in one process every SELECT — on any connection, a fresh
 * one included — returned []. gjsify#1838 fixed it in 0.53.0 (measured: 40 000 `run()`s stay
 * intact), and the batching is kept because a multi-row statement is one transaction and one
 * parse rather than N of each — the `sync.test.ts` resync case still fails on per-row writes.
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
 * A sequence column as a SELECT expression that survives any size.
 *
 * libgda used to type a declared INTEGER column as a 32-bit int, so one value above 2^31-1 —
 * any millisecond timestamp, which is what XMPP's archive order is — made the WHOLE result come
 * back empty (gjsify#1839). That is fixed in 0.53.0 and measured: a 64-bit INTEGER reads back
 * exact on GJS.
 *
 * Kept anyway, deliberately, and this is the one measured gap whose shim survives its fix: the
 * text round-trip is still correct, and dropping it touches three call sites whose readers
 * convert with `num()`. It is a known-redundant helper, not a load-bearing one — delete it with
 * its three call sites in a change of its own rather than inside a version bump.
 */
export const seqColumn = (column: string): string => `${column} || '' AS ${column.replace(/^.*\./, '')}`;
