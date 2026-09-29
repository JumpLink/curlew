/**
 * The receive lease — the lock between a running daemon and a `postbote sync`.
 *
 * Two delivery devices on ONE account are not a harmless duplicate: each of them acknowledges
 * what it received, and the network forgets the message for both, so the two runs interleave
 * and each ends up with half the copy. The lease is what keeps them apart (ADR 0002 §4).
 *
 * A lease, not a lock file, for three reasons:
 *
 *   - it is one row in the same database as the data it protects, so there is no second file to
 *     place, keep 0600 and keep in sync;
 *   - it survives a crash by EXPIRY rather than by a cleanup path that also has to survive a
 *     crash — a daemon that was SIGKILLed simply stops refreshing;
 *   - it is a statement, so it behaves the same on Node and on GJS, where `flock` and `fcntl`
 *     locking are not something to assume.
 *
 * `heartbeat_at` is TEXT on purpose: a declared INTEGER is read back as a 32-bit int on gjsify's
 * libgda, and one millisecond timestamp above 2^31 makes the whole query read as empty
 * (`packages/store/AGENTS.md`, (f)). ISO-8601 UTC sorts and compares as text anyway.
 */

import type { IndexDatabase } from './db.ts';
import { withTransaction } from './db.ts';

/** How often a holder refreshes its lease. */
export const LEASE_HEARTBEAT_MS = 30_000;

/** How many heartbeats a lease stays fresh for — the holder is presumed alive that long. */
export const LEASE_STALE_HEARTBEATS = 3;

/**
 * How long a lease statement waits for another process's write lock before giving up.
 *
 * Set here, per connection, rather than left to the runtime's default, which is not the same on
 * both: a fresh gjsify connection REPORTS `PRAGMA busy_timeout` as 500, while the wait a GJS
 * contender actually made with no pragma of its own was ~6 s (measured cross-process, GJS
 * 1.88.1 / gjsify 0.49.0) — so that reported number does not describe the wait, and the value
 * below is ours on purpose. It is armed once per connection: a heartbeat every 30 s must not
 * spend an execution on it.
 *
 * A taker that runs out of patience gets SQLITE_BUSY, and the caller treats that as "not
 * acquired": a `sync` stands down, a daemon waits. Waiting is the point; failing the run is not.
 */
export const LEASE_BUSY_TIMEOUT_MS = 500;

const armed = new WeakSet<IndexDatabase>();

/** The heartbeat older than which a lease is nobody's. */

/**
 * The lease's own transaction: the write lock from the first statement, and a busy timeout so a
 * competing process QUEUES instead of failing.
 *
 * Without `BEGIN IMMEDIATE` two processes both read "free" and the loser gets SQLITE_BUSY — and
 * not from a timeout: SQLite skips the busy handler for a deferred transaction that upgrades from
 * a read to a write. A lease that throws where it should wait is a lease that takes the account
 * out of service.
 *
 * `BEGIN IMMEDIATE` is a real cross-process write lock on BOTH runtimes — measured on GJS 1.88.1
 * / gjsify 0.49.0 (a contender's `BEGIN IMMEDIATE` blocked for the holder's whole transaction
 * and its write then went through) and on Node, where the same collision fails with
 * `database is locked` (errcode 5). So this is the lease's lock, and nothing below has to
 * compensate for its absence.
 */
function withLeaseTransaction<T>(db: IndexDatabase, fn: () => T): T {
  if (!armed.has(db)) {
    db.exec(`PRAGMA busy_timeout = ${LEASE_BUSY_TIMEOUT_MS}`);
    armed.add(db);
  }
  return withTransaction(db, fn, { immediate: true });
}

/** The heartbeat older than which a lease is nobody's. */
function millis(iso: unknown): number {
  const parsed = Date.parse(String(iso ?? ''));
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function isFresh(heartbeatAt: unknown, now: Date): boolean {
  return now.getTime() - millis(heartbeatAt) < LEASE_STALE_HEARTBEATS * LEASE_HEARTBEAT_MS;
}

export type LeaseTake =
  | { acquired: true }
  /**
   * Somebody else holds a live lease: who, and when it was last heard from. A `null` holder
   * means the index was busy and nobody could be determined — which for the caller is the same
   * as "not mine": wait or stand down, never connect blind.
   */
  | { acquired: false; holder: string | null; heartbeatAt: string | null };

/**
 * Take the lease for one account, or report the holder that has it.
 *
 * Read, decide, write — all three inside `withLeaseTransaction`, whose `BEGIN IMMEDIATE` holds
 * the write lock from the first statement. That lock is the whole correctness argument: two runs
 * cannot both read "free", so the write needs no guard of its own and the result needs no
 * read-back. A live foreign lease is reported, never stolen; a lease whose heartbeat is older
 * than three intervals is stale and is taken over, which is the crash case and needs no cleanup
 * to have run first.
 *
 * The shapes are plain `INSERT`/`SELECT` on purpose:
 * gjsify gap: libgda cannot parse an EXISTS subquery — `INSERT … SELECT … WHERE NOT EXISTS (…)`
 * fails with `near "(": syntax error` (being fixed in gjsify core) — so the guard a conditional
 * claim would need cannot be written in SQL here. Revisit at the next bump; the lock makes it
 * optional, not necessary.
 */
export function takeReceiveLease(
  db: IndexDatabase,
  backend: string,
  accountId: string,
  holder: string,
  now: Date,
): LeaseTake {
  return withLeaseTransaction(db, (): LeaseTake => {
    const row = db
      .prepare('SELECT holder, heartbeat_at FROM receive_leases WHERE backend = ? AND account_id = ?')
      .get(backend, accountId) as { holder?: unknown; heartbeat_at?: unknown } | undefined;
    const incumbent = row ? String(row.holder) : null;
    const heartbeatAt = row ? String(row.heartbeat_at) : null;
    if (incumbent !== null && incumbent !== holder && heartbeatAt !== null && isFresh(heartbeatAt, now)) {
      return { acquired: false, holder: incumbent, heartbeatAt };
    }
    db.prepare(
      `INSERT OR REPLACE INTO receive_leases (backend, account_id, holder, heartbeat_at)
         VALUES (?, ?, ?, ?)`,
    ).run(backend, accountId, holder, now.toISOString());
    return { acquired: true };
  });
}

/**
 * Move the lease's heartbeat forward. Only the holder may: a process that lost the lease (or
 * never had it) must not keep it alive.
 */
export function refreshReceiveLease(
  db: IndexDatabase,
  backend: string,
  accountId: string,
  holder: string,
  now: Date,
): boolean {
  return withLeaseTransaction(db, (): boolean => {
    const row = db
      .prepare('SELECT holder FROM receive_leases WHERE backend = ? AND account_id = ?')
      .get(backend, accountId) as { holder?: unknown } | undefined;
    if (!row || String(row.holder) !== holder) return false;
    db.prepare(
      `UPDATE receive_leases SET heartbeat_at = ? WHERE backend = ? AND account_id = ? AND holder = ?`,
    ).run(now.toISOString(), backend, accountId, holder);
    return true;
  });
}

/** Drop the lease — only for the holder. Returns whether a row was actually dropped. */
export function releaseReceiveLease(
  db: IndexDatabase,
  backend: string,
  accountId: string,
  holder: string,
): boolean {
  return withLeaseTransaction(db, (): boolean => {
    const row = db
      .prepare('SELECT holder FROM receive_leases WHERE backend = ? AND account_id = ?')
      .get(backend, accountId) as { holder?: unknown } | undefined;
    if (!row || String(row.holder) !== holder) return false;
    db.prepare('DELETE FROM receive_leases WHERE backend = ? AND account_id = ? AND holder = ?').run(
      backend,
      accountId,
      holder,
    );
    return true;
  });
}
