/**
 * The receive lease — the lock between a running daemon and a `curlew sync`.
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
 * `heartbeat_at` and `expires_at` are TEXT because ISO-8601 UTC sorts and compares as text
 * anyway, which is all the lease needs of them — not because an INTEGER would not survive the
 * round trip (gjsify#1841 reads one exactly; `packages/store/AGENTS.md`, (f)).
 *
 * The HOLDER writes both, and `expires_at` is its own answer to "how long is this lease good":
 * its heartbeat plus `LEASE_STALE_HEARTBEATS` times ITS refresh interval. A taker only compares a
 * time, so nobody can shorten somebody else's lease by refreshing more often than they do — which
 * is exactly what a window derived from the taker's interval allowed.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { IndexDatabase } from './db.ts';
import { withTransaction } from './db.ts';

/**
 * What a probe can say about a pid on THIS host: no such process, a process with an identity
 * (`<boot id>/<start time>`, which a reused pid does not share), or "cannot judge" (no `/proc`,
 * or a Flatpak, where every instance has its own pid namespace and a live holder in another
 * instance would look gone).
 */
export type ProcessStamp = { state: 'gone' } | { state: 'unknown' } | { state: 'present'; id: string | null };

/** The port tests inject: how the lease learns whether a pid is still the process that wrote it. */
export interface ProcessProbe {
  stamp(pid: number): ProcessStamp;
}

/** Holders are `<pid>` (daemon), `sync-<pid>` or `send-<pid>`; anything else cannot be judged. */
export function holderPid(holder: string): number | null {
  const match = /^(?:sync-|send-)?(\d+)$/.exec(holder);
  return match === null ? null : Number(match[1]);
}

export const procProbe: ProcessProbe = {
  stamp(pid: number): ProcessStamp {
    if (!existsSync('/proc/self')) return { state: 'unknown' };
    if (existsSync('/.flatpak-info') || process.env.FLATPAK_ID) return { state: 'unknown' };
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (error) {
      const code = (error as { code?: string }).code;
      return code === 'ENOENT' || code === 'ESRCH' ? { state: 'gone' } : { state: 'unknown' };
    }
    // Field 2 (comm) may hold spaces and parens: count from the LAST ')'. Field 22 is the start time.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const started = fields[19];
    if (!started) return { state: 'present', id: null };
    let boot = '';
    try {
      boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      return { state: 'present', id: null };
    }
    return { state: 'present', id: `${boot}/${started}` };
  },
};

/**
 * Is the process behind a lease row still the one that took it? Unjudgeable holders (other
 * hosts, odd ids, old rows without a stamp for a pid that exists) count as alive: only the
 * lease's own expiry frees them. A pid that is gone, or that now belongs to a process with
 * another start time or boot, is dead.
 */
export function holderIsAlive(holder: string, recorded: string | null, probe: ProcessProbe = procProbe): boolean {
  const pid = holderPid(holder);
  if (pid === null) return true;
  const seen = probe.stamp(pid);
  if (seen.state === 'unknown') return true;
  if (seen.state === 'gone') return false;
  if (recorded === null || seen.id === null) return true;
  return seen.id === recorded;
}

/** How often a holder refreshes its lease. */
export const LEASE_HEARTBEAT_MS = 30_000;

/**
 * How many missed heartbeats make a lease stale — the holder is presumed alive until then.
 *
 * Three, against the interval the holder refreshes at, NOT a fixed 30 s: a holder that refreshes
 * every 100 s must not be declared dead halfway through its own interval.
 */
const LEASE_STALE_HEARTBEATS = 3;

/**
 * The lease's own transaction: the write lock from the first statement, and — from the
 * connection's busy timeout (`INDEX_BUSY_TIMEOUT_MS`, set in `openIndexDb`) — a wait, so a
 * competing process QUEUES instead of failing.
 *
 * A taker that runs out of patience gets SQLITE_BUSY, and the caller treats that as "not
 * acquired": a `sync` stands down, a daemon waits. Waiting is the point; failing the run is not.
 * (The lease used to arm its own, shorter timeout here; that clamped the whole connection's wait
 * after the first heartbeat, so it is gone.)
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
  return withTransaction(db, fn);
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
 * The shapes are plain `SELECT` and `INSERT OR REPLACE` on purpose: the decision belongs in one
 * place, under the lock, where it can be read against the whole argument above. A single
 * conditional claim (`INSERT … SELECT … WHERE NOT EXISTS (…)`) is expressible here — libgda
 * renders an `EXISTS` subquery correctly since gjsify#1893, pinned by a test in this repo — but
 * it would spread one rule across two statements and buy only one execution. If the lock ever
 * goes, that is the form to reach for.
 */
export function takeReceiveLease(
  db: IndexDatabase,
  backend: string,
  accountId: string,
  holder: string,
  now: Date,
  intervalMs: number = LEASE_HEARTBEAT_MS,
  probe: ProcessProbe = procProbe,
): LeaseTake {
  return withLeaseTransaction(db, (): LeaseTake => {
    const row = db
      .prepare(
        'SELECT holder, heartbeat_at, expires_at, holder_stamp FROM receive_leases WHERE backend = ? AND account_id = ?',
      )
      .get(backend, accountId) as
      | { holder?: unknown; heartbeat_at?: unknown; expires_at?: unknown; holder_stamp?: unknown }
      | undefined;
    const incumbent = row ? String(row.holder) : null;
    const heartbeatAt = row ? String(row.heartbeat_at) : null;
    // A holder whose process is gone on this host holds nothing, fresh expiry or not: a restarted
    // daemon would otherwise wait out the dead one's 90 s.
    if (
      incumbent !== null &&
      incumbent !== holder && isFresh(row?.expires_at, now) &&
      holderIsAlive(incumbent, row?.holder_stamp == null ? null : String(row.holder_stamp), probe)
    ) {
      return { acquired: false, holder: incumbent, heartbeatAt };
    }
    const pid = holderPid(holder);
    const own = pid === null ? null : probe.stamp(pid);
    const stamp = own !== null && own.state === 'present' ? own.id : null;
    db.prepare(
      `INSERT OR REPLACE INTO receive_leases (backend, account_id, holder, heartbeat_at, expires_at, holder_stamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(backend, accountId, holder, now.toISOString(), expiresAt(now, intervalMs), stamp);
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

/**
 * Drop every lease a holder still has — the daemon's last act, for a stop that raced an account
 * loop which never reached its own release. Returns how many rows went.
 */
export function releaseAllReceiveLeases(db: IndexDatabase, holder: string): number {
  return withLeaseTransaction(db, (): number => {
    const row = db.prepare('SELECT COUNT(*) AS n FROM receive_leases WHERE holder = ?').get(holder) as
      | { n?: unknown }
      | undefined;
    const n = Number(row?.n ?? 0);
    if (n > 0) db.prepare('DELETE FROM receive_leases WHERE holder = ?').run(holder);
    return n;
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
