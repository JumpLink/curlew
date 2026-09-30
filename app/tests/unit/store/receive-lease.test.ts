import { describe, expect, it } from '@gjsify/unit';

import {
  LEASE_BUSY_TIMEOUT_MS,
  LEASE_HEARTBEAT_MS,
  type IndexDatabase,
  migrate,
  refreshReceiveLease,
  SCHEMA_VERSION,
  releaseReceiveLease,
  takeReceiveLease,
  withTransaction,
} from '@postbote/store';
import { freshDb } from './fixtures.ts';

/**
 * The receive lease: how a running daemon and a `postbote sync` stay off the same delivery
 * account. Two delivery devices on one account each acknowledge half the messages, so the lock
 * is not a nicety — it is what makes the stored copy complete (ADR 0002 §4).
 *
 * Synthetic ids only: a lease carries a backend name, an account id and a pid.
 */

const BACKEND = 'whatsapp';
const ACCOUNT = 'wa-1';
const T0 = new Date('2026-09-29T10:00:00.000Z');

const at = (ms: number) => new Date(T0.getTime() + ms);

/** The lease row's holder, read straight from the table — the module has no "list" on purpose. */
function leaseHolder(db: IndexDatabase, accountId: string): string | null {
  const row = db
    .prepare('SELECT holder FROM receive_leases WHERE backend = ? AND account_id = ?')
    .get(BACKEND, accountId) as { holder?: unknown } | undefined;
  return row ? String(row.holder) : null;
}

function leaseRows(db: IndexDatabase): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM receive_leases').get() as { n: number };
  return Number(row.n);
}

/** What the connection will wait for a write lock, in ms. Zero means "fail at once". */
function busyTimeoutMs(db: IndexDatabase): number {
  const row = db.prepare('PRAGMA busy_timeout').get() as Record<string, unknown> | undefined;
  return Number(row?.timeout ?? 0);
}

export default async () => {
  await describe('the receive lease', async () => {
    await it('one holder at a time, and a stranger gets the holder back', async () => {
      const db = freshDb();
      try {
        expect(takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-1', T0).acquired).toBe(true);
        const second = takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-2', at(1_000));
        expect(second.acquired).toBe(false);
        expect(second.acquired === false && second.holder).toBe('pid-1');
        // The same holder may take it again — that is a heartbeat, not a conflict.
        expect(takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-1', at(1_000)).acquired).toBe(true);
        // Another account is a different row.
        expect(takeReceiveLease(db, BACKEND, 'wa-2', 'pid-2', at(1_000)).acquired).toBe(true);
      } finally {
        db.close();
      }
    });

    await it('a stale lease is taken over — a crashed holder expires', async () => {
      const db = freshDb();
      try {
        takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-1', T0);
        // One interval later it is still fresh: the holder is presumed alive.
        expect(takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-2', at(LEASE_HEARTBEAT_MS)).acquired).toBe(false);
        // Three intervals later it is not, and the takeover succeeds.
        expect(takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-2', at(3 * LEASE_HEARTBEAT_MS)).acquired).toBe(
          true,
        );
        expect(leaseHolder(db, ACCOUNT)).toBe('pid-2');
      } finally {
        db.close();
      }
    });

    await it('a heartbeat extends the lease, and only for the holder', async () => {
      const db = freshDb();
      try {
        takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-1', T0);
        // A stranger cannot keep a lease alive it does not hold.
        expect(refreshReceiveLease(db, BACKEND, ACCOUNT, 'pid-2', at(LEASE_HEARTBEAT_MS))).toBe(false);
        expect(leaseRows(db)).toBe(1);
        expect(refreshReceiveLease(db, BACKEND, ACCOUNT, 'pid-1', at(LEASE_HEARTBEAT_MS))).toBe(true);
        // Refreshed at 30 s, it is fresh again well past where it would have expired.
        expect(takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-2', at(3 * LEASE_HEARTBEAT_MS)).acquired).toBe(
          false,
        );
        expect(leaseHolder(db, ACCOUNT)).toBe('pid-1');
        // An account nobody holds is not a row at all.
        expect(leaseHolder(db, 'wa-9')).toBe(null);
      } finally {
        db.close();
      }
    });

    await it('releases its own lease only', async () => {
      const db = freshDb();
      try {
        takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-1', T0);
        expect(releaseReceiveLease(db, BACKEND, ACCOUNT, 'pid-2')).toBe(false);
        expect(leaseRows(db)).toBe(1);
        expect(releaseReceiveLease(db, BACKEND, ACCOUNT, 'pid-1')).toBe(true);
        expect(leaseRows(db)).toBe(0);
        // Releasing what is not there is not an error, just nothing to do.
        expect(releaseReceiveLease(db, BACKEND, ACCOUNT, 'pid-1')).toBe(false);
      } finally {
        db.close();
      }
    });

    await it('takes the write lock up front, and waits instead of failing', async () => {
      const db = freshDb();
      try {
        // Two processes, two takes. A deferred BEGIN reads first and upgrades at the write, and
        // SQLite does NOT run the busy handler for that upgrade (SQLITE_BUSY_SNAPSHOT): both
        // would read "free" and one would then fail instead of waiting its turn. BEGIN
        // IMMEDIATE plus a busy timeout is what turns that into a queue. The lock itself was
        // MEASURED cross-process on both runtimes — see the note on `withLeaseTransaction`.
        const statements: string[] = [];
        const exec = db.exec.bind(db);
        (db as { exec: typeof db.exec }).exec = ((sql: string) => {
          statements.push(sql.trim());
          return exec(sql);
        }) as typeof db.exec;
        takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-1', T0);
        // Once per connection: the pragma, then the transaction that needs it.
        expect(statements[0]).toBe(`PRAGMA busy_timeout = ${LEASE_BUSY_TIMEOUT_MS}`);
        expect(statements[1]).toBe('BEGIN IMMEDIATE');
        expect(statements[statements.length - 1]).toBe('COMMIT');
        // A second lease statement does not spend an execution on the pragma again.
        const after = statements.length;
        takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-1', at(1_000));
        expect(statements.slice(after).some((s) => s.startsWith('PRAGMA'))).toBe(false);
        // A rolled-back take rolls back with it, and one connection, one pragma.
        expect(() =>
          withTransaction(
            db,
            () => {
              throw new Error('nope');
            },
            { immediate: true },
          ),
        ).toThrow(/nope/);
        expect(statements[statements.length - 1]).toBe('ROLLBACK');
        expect(busyTimeoutMs(db)).toBe(LEASE_BUSY_TIMEOUT_MS);
      } finally {
        db.close();
      }
    });

    // The seam tests read `loggedOutBackend` from a fake. This one proves the real path: the
    // column exists after migration, the delivery sync writes and clears it, and a status report
    // reads it back. A seam that only works in its own test proves nothing about the product.
    await it('remembers a dropped link in the index, and forgets it once a run succeeds', async () => {
      const db = freshDb();
      try {
        const columns = (db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>).map(
          (c) => c.name,
        );
        expect(columns.includes('link_dropped_at')).toBe(true);

        db.prepare(
          `INSERT INTO accounts (id, provider, last_sync_at, link_dropped_at)
             VALUES (?, 'signal', ?, ?)`,
        ).run(ACCOUNT, '2026-09-30T10:00:00.000Z', '2026-09-30T10:00:00.000Z');
        let row = db.prepare('SELECT link_dropped_at FROM accounts WHERE id = ?').get(ACCOUNT) as {
          link_dropped_at: string | null;
        };
        expect(row.link_dropped_at).toBe('2026-09-30T10:00:00.000Z');

        // A later run that reaches the account again clears it: a link can come back, and a
        // stale "dropped" would then be the tool reporting something it knows is untrue.
        db.prepare('UPDATE accounts SET link_dropped_at = NULL WHERE id = ?').run(ACCOUNT);
        row = db.prepare('SELECT link_dropped_at FROM accounts WHERE id = ?').get(ACCOUNT) as {
          link_dropped_at: string | null;
        };
        expect(row.link_dropped_at).toBe(null);
      } finally {
        db.close();
      }
    });

    await it('migrates a v5 index forward without touching a stored message', async () => {
      const db = freshDb();
      try {
        db.prepare(
          `INSERT INTO conversation_messages (id, conversation_id, backend, account_id, presentation,
             from_self, seen, has_attachments, classification, classification_reason, remote_id, body)
           VALUES ('m-1', 'c-1', ?, ?, 'bubble', 0, 0, 0, 'conversational', 'known-contact', 'x-1', 'bleibt')`,
        ).run(BACKEND, ACCOUNT);
        db.prepare(`UPDATE schema_meta SET value = '5' WHERE key = 'schema_version'`).run();
        db.exec('DROP TABLE receive_leases');
        expect(() => migrate(db)).not.toThrow();
        const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
          value: string;
        };
        expect(version.value).toBe(String(SCHEMA_VERSION));
        // v6 has never shipped, so it carries the expiry column from the start: a lease that a
        // taker cannot judge without knowing the holder's interval was never a design.
        const columns = (
          db.prepare('PRAGMA table_info(receive_leases)').all() as Array<{
            name: string;
          }>
        ).map((c) => c.name);
        expect(columns).toContain('expires_at');
        const kept = db.prepare('SELECT body FROM conversation_messages WHERE id = ?').get('m-1') as {
          body: string;
        };
        expect(kept.body).toBe('bleibt');
        // And the new table is usable on the migrated index.
        expect(takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-1', T0).acquired).toBe(true);
      } finally {
        db.close();
      }
    });
  });
};
