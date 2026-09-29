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
 * Set here, per connection, rather than trusted from the runtime: gjsify's libgda wrapper opens
 * the index at 500 ms (measured on GJS 1.88.1 / gjsify 0.49.0), Node's `node:sqlite` sets none,
 * and a lease that only works because of a default is a lease that stops working on an upgrade.
 * It is armed once per connection: a heartbeat every 30 s must not spend an execution on it.
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
 * gjsify gap (unfixed, libgda's node:sqlite does not hold an explicit transaction's write lock):
 * MEASURED on GJS 1.88.1 / gjsify 0.49.0 — with one process inside `BEGIN IMMEDIATE` plus an
 * UPDATE, a second process's `BEGIN IMMEDIATE` and a bare UPDATE both SUCCEEDED. The same
 * collision on Node's node:sqlite fails with `database is locked` (errcode 5), i.e. the lock is
 * real there. So on GJS the conditional write and the read-back in `takeReceiveLease` are what
 * keep two runs apart, and the heartbeat (which fails as soon as the row is no longer ours) is
 * the safety net. Re-measure at the next bump; the shim is the read-back, not the pragma.
 */
function withLeaseTransaction<T>(db: IndexDatabase, fn: () => T): T {
  if (!armed.has(db)) {
    db.exec(`PRAGMA busy_timeout = ${LEASE_BUSY_TIMEOUT_MS}`);
    armed.add(db);
  }
  return withTransaction(db, fn, { immediate: true });
}

/** The heartbeat older than which a lease is nobody's: the SQL form of `isFresh`. */
function staleBefore(now: Date): string {
  return new Date(now.getTime() - LEASE_STALE_HEARTBEATS * LEASE_HEARTBEAT_MS).toISOString();
}

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
 * Decided in three steps, and the last one is what makes it safe where the transaction is not:
 *
 *   1. read the row — a live foreign lease is reported, not stolen;
 *   2. claim it, and the claim carries its own guard: the `UPDATE` only fires for a row that is
 *      already ours or stale (`holder = ? OR heartbeat_at <= ?`), so it can never clobber a live
 *      foreign lease even if step 1 was read before a competitor wrote. A row that was not there
 *      at all is inserted;
 *   3. read the holder back. If it is not us, we lost the race, and we say so.
 *
 * Step 3 exists because of a measured gjsify gap — on GJS an explicit `BEGIN IMMEDIATE` holds no
 * write lock against another process (see the note on `withLeaseTransaction`), so two runs CAN
 * both read "free" and both write. With the read-back, the loser of that write stands down; what
 * remains is the heartbeat, which stops a holder whose row was clobbered. On Node, where the
 * transaction is real, steps 2 and 3 are a formality.
 *
 * The shapes are plain `UPDATE`/`INSERT`/`SELECT` on purpose: libgda cannot parse
 * `INSERT … SELECT … WHERE NOT EXISTS (…)` (measured: `near "(": syntax error`), so the guard
 * lives in an `UPDATE`'s `WHERE` instead of a subquery.
 *
 * A lease whose heartbeat is older than three intervals is stale and is taken over — the crash
 * case, which needs no cleanup to have run first.
 */
export function takeReceiveLease(
  db: IndexDatabase,
  backend: string,
  accountId: string,
  holder: string,
  now: Date,
): LeaseTake {
  return withLeaseTransaction(db, (): LeaseTake => {
    const at = now.toISOString();
    const row = db
      .prepare('SELECT holder, heartbeat_at FROM receive_leases WHERE backend = ? AND account_id = ?')
      .get(backend, accountId) as { holder?: unknown; heartbeat_at?: unknown } | undefined;
    const incumbent = row ? String(row.holder) : null;
    const heartbeatAt = row ? String(row.heartbeat_at) : null;
    if (incumbent !== null && incumbent !== holder && heartbeatAt !== null && isFresh(heartbeatAt, now)) {
      return { acquired: false, holder: incumbent, heartbeatAt };
    }
    if (incumbent === null) {
      // `OR IGNORE`, not `OR REPLACE`: a competitor that inserted between step 1 and here keeps
      // its row, and the read-back below reports the loser. An ignored insert is rare enough that
      // libgda's warning on it is noise we can afford (the store's own rule against OR IGNORE is
      // about a warning per message, not per lost race).
      db.prepare(
        `INSERT OR IGNORE INTO receive_leases (backend, account_id, holder, heartbeat_at)
           VALUES (?, ?, ?, ?)`,
      ).run(backend, accountId, holder, at);
    } else {
      db.prepare(
        `UPDATE receive_leases SET holder = ?, heartbeat_at = ?
           WHERE backend = ? AND account_id = ? AND (holder = ? OR heartbeat_at <= ?)`,
      ).run(holder, at, backend, accountId, holder, staleBefore(now));
    }
    const settled = db
      .prepare('SELECT holder FROM receive_leases WHERE backend = ? AND account_id = ?')
      .get(backend, accountId) as { holder?: unknown } | undefined;
    const winner = settled ? String(settled.holder) : null;
    return winner === holder ? { acquired: true } : { acquired: false, holder: winner, heartbeatAt };
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
