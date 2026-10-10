import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';

import { type IndexDatabase } from '@curlew/store';
import { openIndex } from '../../../src/core/actions/index-sync.ts';

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
  });
};
