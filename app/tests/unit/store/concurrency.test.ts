import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';

import { type IndexDatabase, rebuildConversations, syncIndex, withTransaction } from '@curlew/store';
import { inPhase, openIndex } from '../../../src/core/actions/index-sync.ts';
import { FakeBackend, message } from './fixtures.ts';

/**
 * The index is shared by the daemon (a long-lived writer), `curlew sync` (a timer), and the MCP
 * server (a reader). Two connections on one file are enough to reproduce what they did to each
 * other: the writer holds the write lock mid-batch and the other process must neither fail to
 * OPEN the index nor fail at once when it wants to write.
 *
 * One process, two connections: the calls are synchronous, so a waiting connection cannot be
 * released by its holder from the same thread — the wait is asserted as elapsed time instead.
 * Synthetic rows only.
 */

function withIndexFile(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-lock-'));
  try {
    fn(join(dir, 'index.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function probe(db: IndexDatabase): string | null {
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = 'probe'`).get() as
    | { value?: string }
    | undefined;
  return row?.value ?? null;
}

const put = (db: IndexDatabase, value: string) =>
  db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('probe', ?)`).run(value);

export default async () => {
  await describe('the index under a concurrent writer', async () => {
    await it('opens and reads while another connection holds the write lock', async () => {
      withIndexFile((path) => {
        const writer = openIndex(path);
        put(writer, 'committed');
        writer.exec('BEGIN IMMEDIATE');
        put(writer, 'in-flight');
        try {
          // What `curlew sync`, the MCP server and every search do first.
          const reader = openIndex(path);
          try {
            // WAL: the reader sees the last COMMITTED state, never the half-written one.
            expect(probe(reader)).toBe('committed');
          } finally {
            reader.close();
          }
        } finally {
          writer.exec('ROLLBACK');
          writer.close();
        }
      });
    });

    await it('makes a second writer wait for the lock instead of failing at once', async () => {
      withIndexFile((path) => {
        const holder = openIndex(path);
        const contender = openIndex(path, { busyTimeoutMs: 100 });
        holder.exec('BEGIN IMMEDIATE');
        try {
          const started = Date.now();
          let failure: unknown;
          try {
            put(contender, 'blocked');
          } catch (err) {
            failure = err;
          }
          const waited = Date.now() - started;
          // Still locked after the timeout, so it does fail — but only after waiting for it.
          expect(failure === undefined).toBe(false);
          expect(waited >= 80).toBe(true);
        } finally {
          holder.exec('ROLLBACK');
          holder.close();
          contender.close();
        }
      });
    });

    await it('fails at once, busy handler or not, when a deferred read-then-write is overtaken', async () => {
      // The cause of "database is locked" in `curlew sync` while the daemon writes: the reader
      // upgrades after another connection committed, SQLITE_BUSY_SNAPSHOT, no wait at all.
      withIndexFile((path) => {
        const daemon = openIndex(path);
        const sync = openIndex(path, { busyTimeoutMs: 2_000 });
        put(daemon, 'before');
        sync.exec('BEGIN');
        try {
          expect(probe(sync)).toBe('before');
          put(daemon, 'delivery-batch');
          const started = Date.now();
          let failure: unknown;
          try {
            put(sync, 'sync-batch');
          } catch (err) {
            failure = err;
          }
          expect(failure === undefined).toBe(false);
          expect(Date.now() - started < 500).toBe(true);
        } finally {
          sync.exec('ROLLBACK');
          daemon.close();
          sync.close();
        }
      });
    });

    await it('takes the write lock when a transaction begins, before its first statement', async () => {
      withIndexFile((path) => {
        const daemon = openIndex(path, { busyTimeoutMs: 50 });
        const sync = openIndex(path);
        put(daemon, 'before');
        try {
          withTransaction(sync, () => {
            // Only a lock held since BEGIN keeps the daemon out while this one has merely read.
            expect(probe(sync)).toBe('before');
            let blocked = false;
            try {
              put(daemon, 'delivery-batch');
            } catch {
              blocked = true;
            }
            expect(blocked).toBe(true);
            put(sync, 'sync-batch');
          });
          expect(probe(daemon)).toBe('sync-batch');
        } finally {
          daemon.close();
          sync.close();
        }
      });
    });

    await it('names the phase when the index stays locked, and leaves other errors alone', async () => {
      let locked: unknown;
      try {
        await inPhase('delivery', () => {
          throw new Error('database is locked');
        });
      } catch (err) {
        locked = err;
      }
      expect(String((locked as Error).message)).toContain('delivery phase');
      expect(String((locked as Error).message)).toContain('database is locked');
      let other: unknown;
      try {
        await inPhase('mail', () => {
          throw new Error('no such table');
        });
      } catch (err) {
        other = err;
      }
      expect((other as Error).message).toBe('no such table');
    });

    await it('lets the waiting writer through once the lock is released', async () => {
      withIndexFile((path) => {
        const holder = openIndex(path);
        const contender = openIndex(path, { busyTimeoutMs: 100 });
        holder.exec('BEGIN IMMEDIATE');
        put(holder, 'first');
        holder.exec('COMMIT');
        try {
          put(contender, 'second');
          expect(probe(holder)).toBe('second');
        } finally {
          holder.close();
          contender.close();
        }
      });
    });

    await it('lets a sender write between the chunks of a large conversation rebuild', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-lock-'));
      const path = join(dir, 'index.db');
      const follower = openIndex(path);
      // The sender: a second connection with a short timeout, so a held lock would fail it.
      const sender = openIndex(path, { busyTimeoutMs: 50 });
      try {
        const backend = new FakeBackend();
        backend.put(
          'INBOX',
          Array.from({ length: 1300 }, (_, i) =>
            message(i + 1, `Thread ${i + 1}`, 'body', { messageId: `<t${i + 1}@example.org>` }),
          ),
        );
        await syncIndex(follower, backend, { now: () => new Date('2026-08-06T12:00:00Z') });

        let chunks = 0;
        const result = rebuildConversations(follower, {
          onChunk: () => {
            chunks++;
            // What `curlew send` does to the index: it must not meet the follower's lock.
            put(sender, `sent-${chunks}`);
          },
        });
        expect(result.conversations).toBe(1300);
        // Rows are written 500 at a time, so a first rebuild is several transactions, not one.
        expect(chunks > 3).toBe(true);
        expect(probe(follower)).toBe(`sent-${chunks}`);

        // Nothing changed since: a steady-state rebuild opens no write transaction at all.
        let again = 0;
        rebuildConversations(follower, { onChunk: () => again++ });
        expect(again).toBe(0);
      } finally {
        follower.close();
        sender.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
