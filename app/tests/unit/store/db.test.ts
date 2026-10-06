import { describe, expect, it } from '@gjsify/unit';

import { insertMany, openIndexDb, seqColumn, type IndexDatabase } from '@curlew/store';

/**
 * The libgda-backed `node:sqlite` reads columns, and what it hands back is a contract this
 * package's callers are written against. Two of those readings were workarounds and are now the
 * library's own behaviour, so they are pinned here rather than left to a comment:
 *
 *   - a 64-bit INTEGER is exact (gjsify#1841), so `seqColumn` is only an alias and a
 *     millisecond timestamp survives the round trip as the Number it is;
 *   - a broken query THROWS (gjsify#1838), where it used to be swallowed into an empty result.
 *     That is the change with teeth: a search that silently answered "nothing matched" now
 *     raises, which is why the FTS MATCH is built by `toFts5Match()` and not from raw input.
 *
 * Runs against the real bundled wrapper on BOTH runtimes, which is the only place the claim
 * means anything — a fixture would pin the test, not the library.
 */

/** A millisecond timestamp, the XMPP archive order and Matrix's `origin_server_ts`. */
const MS = 1_756_000_000_000;

function withDb(fn: (db: IndexDatabase) => void): void {
  const db = openIndexDb(':memory:');
  try {
    fn(db);
  } finally {
    db.close();
  }
}

export default async () => {
  await describe('reading an INTEGER column', async () => {
    await it('returns a value above 2^31 as the Number it is, not as text or nothing', async () => {
      withDb((db) => {
        db.exec('CREATE TABLE t (id TEXT, seq INTEGER)');
        insertMany(db, 'INSERT INTO t (id, seq)', [
          ['small', 42],
          ['big', MS],
          ['zero', 0],
        ]);
        // Alias and bare column must agree — that is the whole content of `seqColumn` now.
        const aliased = db.prepare(`SELECT id, ${seqColumn('seq')} FROM t`).all() as Array<{
          id: string;
          seq: unknown;
        }>;
        const plain = db.prepare('SELECT id, seq FROM t').all() as Array<{ id: string; seq: unknown }>;
        const byId = (rows: Array<{ id: string; seq: unknown }>): number =>
          Number(rows.find((r) => r.id === 'big')?.seq);
        expect(byId(aliased)).toBe(MS);
        expect(byId(aliased)).toBe(byId(plain));
        for (const row of aliased) expect(typeof row.seq).toBe('number');
      });
    });

    await it('keeps NULL null through the alias, so "no sequence" is still distinguishable', async () => {
      withDb((db) => {
        db.exec('CREATE TABLE t (id TEXT, seq INTEGER)');
        insertMany(db, 'INSERT INTO t (id, seq)', [
          ['none', null],
          ['zero', 0],
        ]);
        const rows = db.prepare(`SELECT id, ${seqColumn('seq')} FROM t`).all() as Array<{
          id: string;
          seq: unknown;
        }>;
        // The old `col || ''` could not tell them apart: both came back as a value JS could
        // coerce, and `loadCursors` relies on NULL to mean "this chat has no sequence yet".
        expect(rows.find((r) => r.id === 'none')?.seq).toBeNull();
        expect(rows.find((r) => r.id === 'zero')?.seq).toBe(0);
      });
    });

    await it('refuses a value past MAX_SAFE_INTEGER rather than rounding it', async () => {
      withDb((db) => {
        db.exec('CREATE TABLE t (v INTEGER)');
        // MAX_SAFE_INTEGER is the largest integer a double holds exactly, and it reads back;
        // one past it throws. Measured, not assumed — the earlier claim that 2^53 itself is fine
        // is wrong, and this is the test that says so.
        insertMany(db, 'INSERT INTO t (v)', [[Number.MAX_SAFE_INTEGER]]);
        const exact = db.prepare('SELECT v FROM t').get() as { v: unknown };
        expect(Number(exact.v)).toBe(Number.MAX_SAFE_INTEGER);
        insertMany(db, 'INSERT INTO t (v)', [[Number.MAX_SAFE_INTEGER + 1]]);
        // The bound is the honest one: a silent round would be a wrong sequence, and a sequence
        // decides what a sync fetches next.
        expect(() => db.prepare('SELECT v FROM t').all()).toThrow();
      });
    });
  });

  await describe('a query that cannot run', async () => {
    await it('throws instead of answering with no rows', async () => {
      withDb((db) => {
        db.exec('CREATE TABLE t (id TEXT)');
        insertMany(db, 'INSERT INTO t (id)', [['a']]);
        // Each of these used to be indistinguishable from "nothing matched", which is how a
        // broken index looks like an empty mailbox. The index's own queries are written so they
        // cannot reach this state; this is the backstop that makes a mistake loud.
        expect(() => db.prepare('SELECT nope FROM t').all()).toThrow();
        expect(() => db.prepare('SELECT * FROM ghost').all()).toThrow();
        expect(() => db.prepare('SELECT FROM WHERE').all()).toThrow();
        expect(() => db.prepare('INSERT INTO ghost (id) VALUES (?)').run('x')).toThrow();
        // A real miss is still a miss, and still not an error.
        expect(db.prepare('SELECT id FROM t WHERE id = ?').all('b')).toEqualArray([]);
        expect(db.prepare('SELECT id FROM t WHERE id = ?').get('b')).toBeUndefined();
        expect(db.prepare('SELECT id FROM t').all().length).toBe(1);
      });
    });
  });

  await describe('the execution budget', async () => {
    await it(
      'leaves reads complete after tens of thousands of writes in one process',
      async () => {
        withDb((db) => {
          db.exec('CREATE TABLE t (id TEXT, n INTEGER)');
          // Past the ~16 000 one-row `run()`s at which every SELECT used to come back empty on
          // ANY connection, a fresh one included. Multi-row writes spend fewer executions than
          // that on their own, so the loop also counts one statement per chunk — the shape the
          // sync engines actually use.
          const n = 20_000;
          const rows = Array.from({ length: n }, (_, i) => [`r${i}`, i]);
          for (let i = 0; i < rows.length; i += 100) {
            insertMany(db, 'INSERT INTO t (id, n)', rows.slice(i, i + 100));
          }
          const count = db.prepare('SELECT COUNT(*) AS total FROM t').get() as { total: unknown };
          expect(Number(count.total)).toBe(n);
          const last = db.prepare('SELECT id, n FROM t WHERE id = ?').get(`r${n - 1}`) as {
            id: string;
            n: unknown;
          };
          expect(last.id).toBe(`r${n - 1}`);
          expect(Number(last.n)).toBe(n - 1);
        });
      },
      { timeout: 300_000 },
    );
  });
};
