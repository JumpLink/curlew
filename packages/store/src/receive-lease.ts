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
 * `heartbeat_at` and `expires_at` are TEXT on purpose: a declared INTEGER is read back as a
 * 32-bit int on gjsify's libgda, and one millisecond timestamp above 2^31 makes the whole query
 * read as empty (`packages/store/AGENTS.md`, (f)). ISO-8601 UTC sorts and compares as text anyway.
 *
 * The HOLDER writes both, and `expires_at` is its own answer to "how long is this lease good":
 * its heartbeat plus `LEASE_STALE_HEARTBEATS` times ITS refresh interval. A taker only compares a
 * time, so nobody can shorten somebody else's lease by refreshing more often than they do — which
 * is exactly what a window derived from the taker's interval allowed.
 */

import type { IndexDatabase } from './db.ts';
import { withTransaction } from './db.ts';

/** How often a holder refreshes its lease. */
export const LEASE_HEARTBEAT_MS = 30_000;

/**
 * How many missed heartbeats make a lease stale — the holder is presumed alive until then.
 *
 * Three, against the interval the holder refreshes at, NOT a fixed 30 s: a holder that refreshes
 * every 100 s must not be declared dead halfway through its own interval.
 */
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
/** The heartbeat older than which a lease is nobody's. */
function millis(iso: unknown): number {
  const parsed = Date.parse(String(iso ?? ''));
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/** When a lease taken (or refreshed) at `now` by a holder refreshing every `intervalMs` runs out. */
function expiresAt(now: Date, intervalMs: number): string {
  return new Date(now.getTime() + LEASE_STALE_HEARTBEATS * intervalMs).toISOString();
}

/** Fresh iff the holder's own expiry has not passed. The taker needs no interval of its own. */
function isFresh(expiresAt: unknown, now: Date): boolean {
  return now.getTime() < millis(expiresAt);
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
 * read-back. A live foreign lease is reported, never stolen; an expired one is taken over, which
 * is the crash case and needs no cleanup to have run first. `intervalMs` is the interval THIS run
 * refreshes at: it decides the expiry it writes, and says nothing about anybody else's lease.
 *
 * The shapes are plain `INSERT`/`SELECT` on purpose:
 * gjsify gap (unfixed, fix in progress): libgda cannot parse an EXISTS subquery —
 * `INSERT … SELECT … WHERE NOT EXISTS (…)` fails with `near "(": syntax error` — so a conditional
 * claim cannot be written in SQL here. Revisit at the next bump; the lock makes it optional, not
 * necessary.
 */
export function takeReceiveLease(
  db: IndexDatabase,
  backend: string,
  accountId: string,
  holder: string,
  now: Date,
  intervalMs: number = LEASE_HEARTBEAT_MS,
): LeaseTake {
  return withLeaseTransaction(db, (): LeaseTake => {
    const row = db
      .prepare(
        'SELECT holder, heartbeat_at, expires_at FROM receive_leases WHERE backend = ? AND account_id = ?',
      )
      .get(backend, accountId) as
      | { holder?: unknown; heartbeat_at?: unknown; expires_at?: unknown }
      | undefined;
    const incumbent = row ? String(row.holder) : null;
    const heartbeatAt = row ? String(row.heartbeat_at) : null;
    if (incumbent !== null && incumbent !== holder && isFresh(row?.expires_at, now)) {
      return { acquired: false, holder: incumbent, heartbeatAt };
    }
    db.prepare(
      `INSERT OR REPLACE INTO receive_leases (backend, account_id, holder, heartbeat_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(backend, accountId, holder, now.toISOString(), expiresAt(now, intervalMs));
    return { acquired: true };
  });
}

/**
 * Move the lease's heartbeat — and with it its expiry — forward. Only the holder may: a process
 * that lost the lease (or never had it) must not keep it alive, and must not extend it either.
 */
export function refreshReceiveLease(
  db: IndexDatabase,
  backend: string,
  accountId: string,
  holder: string,
  now: Date,
  intervalMs: number = LEASE_HEARTBEAT_MS,
): boolean {
  return withLeaseTransaction(db, (): boolean => {
    const row = db
      .prepare('SELECT holder FROM receive_leases WHERE backend = ? AND account_id = ?')
      .get(backend, accountId) as { holder?: unknown } | undefined;
    if (!row || String(row.holder) !== holder) return false;
    db.prepare(
      `UPDATE receive_leases SET heartbeat_at = ?, expires_at = ?
         WHERE backend = ? AND account_id = ? AND holder = ?`,
    ).run(now.toISOString(), expiresAt(now, intervalMs), backend, accountId, holder);
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
