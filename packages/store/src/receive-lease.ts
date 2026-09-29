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
 * One transaction: two daemons starting at the same moment must not both read "free" and both
 * write. A lease whose heartbeat is older than three intervals is stale and is taken over — that
 * is the crash case, and it needs no cleanup to have run first.
 */
export function takeReceiveLease(
  db: IndexDatabase,
  backend: string,
  accountId: string,
  holder: string,
  now: Date,
): LeaseTake {
  return withTransaction(db, (): LeaseTake => {
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
  return withTransaction(db, (): boolean => {
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
  return withTransaction(db, (): boolean => {
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
