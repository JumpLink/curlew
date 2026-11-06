import { describe, expect, it } from '@gjsify/unit';

import { searchIndex, type SyncProgress, syncIndex, syncStatus } from '@curlew/store';
import { AT, FakeBackend, folder, freshDb, message } from './fixtures.ts';

/**
 * The sync engine is the most intricate code in the project: UIDVALIDITY resets, expunges,
 * flag drift and the cheap no-op path, against the fake server in fixtures.ts.
 */

export default async () => {
  await describe('initial sync', async () => {
    await it('indexes every message and makes it searchable', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'Energieberatung'), message(2, 'Angebot Wärmepumpe')]);
      try {
        const result = await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        expect(result.added).toBe(2);
        expect(result.failed).toBe(false);
        expect(searchIndex(db, { query: 'Wärmepumpe' }).length).toBe(1);
        expect(searchIndex(db, {}).length).toBe(2);
      } finally {
        db.close();
      }
    });

    // `curlew sync` printed nothing for minutes while it worked, and a CLI that shows nothing
    // for minutes cannot be told from one that has hung. The facts already exist at three
    // moments; this pins that they are reported, and that nothing else is: a progress line is a
    // log line, so it carries counts and never another person's words (ADR 0002 §6).
    await it('reports progress while it works, with counts and nothing else', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'Energieberatung'), message(2, 'Angebot Wärmepumpe')]);
      const seen: SyncProgress[] = [];
      try {
        await syncIndex(db, backend, {
          now: AT('2026-08-06T12:00:00Z'),
          onProgress: (event) => seen.push(event),
        });
      } finally {
        db.close();
      }

      expect(seen.length > 0).toBe(true);
      expect(seen.some((e) => e.type === 'account-start')).toBe(true);
      expect(seen.some((e) => e.type === 'folder-done')).toBe(true);
      // The last mail event must carry the running total, so a single line can show progress
      // without keeping a counter of its own.
      const last = seen[seen.length - 1];
      expect(last.added).toBe(2);
      // Nothing about the messages themselves may travel in a progress event.
      const text = JSON.stringify(seen);
      expect(text.includes('Wärmepumpe')).toBe(false);
      expect(text.includes('Energieberatung')).toBe(false);
    });

    await it('says a folder is done even when it added nothing', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'One')]);
      const seen: SyncProgress[] = [];
      try {
        await syncIndex(db, backend, {
          now: AT('2026-08-06T12:00:00Z'),
          onProgress: (event) => seen.push(event),
        });
        // A second run has nothing new in every folder. If only non-empty folders reported, this
        // run would look like a hang from the outside.
        seen.length = 0;
        await syncIndex(db, backend, {
          now: AT('2026-08-06T12:05:00Z'),
          onProgress: (event) => seen.push(event),
        });
      } finally {
        db.close();
      }
      expect(seen.some((e) => e.type === 'folder-done')).toBe(true);
    });

    await it('records the cursor so a second run adds only what is new', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'One'), message(2, 'Two')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        backend.put('INBOX', [message(1, 'One'), message(2, 'Two'), message(3, 'Three')]);
        const second = await syncIndex(db, backend, { now: AT('2026-08-06T12:05:00Z') });
        expect(second.added).toBe(1);
        expect(searchIndex(db, {}).length).toBe(3);
      } finally {
        db.close();
      }
    });

    await it('never re-adds a message already indexed', async () => {
      // `<n>:*` returns at least the highest existing UID even when n is past the end, so a
      // naive engine re-inserts the newest message on every run. That is the classic RFC 3501
      // trap, and the reason the loop discards anything at or below the cursor.
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'One')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        await syncIndex(db, backend, { fullScan: true, now: AT('2026-08-06T18:00:00Z') });
        await syncIndex(db, backend, { fullScan: true, now: AT('2026-08-07T02:00:00Z') });
        expect(searchIndex(db, {}).length).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  await describe('the cheap no-op path', async () => {
    await it('skips a folder whose uidNext AND count are unchanged', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'One')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        const before = backend.flagScans;
        // Only 10 minutes later, so the periodic full scan is not yet due.
        const second = await syncIndex(db, backend, { now: AT('2026-08-06T12:10:00Z') });
        expect(second.folders[0].skipped).toBe(true);
        expect(second.added).toBe(0);
        // The point of the skip: no flag scan at all.
        expect(backend.flagScans).toBe(before);
      } finally {
        db.close();
      }
    });

    await it('does the full pass once it is due', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'One')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        const before = backend.flagScans;
        const later = await syncIndex(db, backend, {
          fullScanIntervalHours: 6,
          now: AT('2026-08-06T19:00:00Z'),
        });
        expect(later.folders[0].skipped).toBe(false);
        expect(backend.flagScans).toBe(before + 1);
      } finally {
        db.close();
      }
    });
  });

  await describe('UIDVALIDITY', async () => {
    await it('rebuilds the folder from scratch when it changes', async () => {
      // Every stored UID now names a different message, or none. Nothing can be reused, and
      // keeping the old rows would mean serving results that point at the wrong messages.
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'Old one'), message(2, 'Old two')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        expect(searchIndex(db, { query: 'Old' }).length).toBe(2);

        backend.uidValidity = 2;
        backend.uidNext = 1;
        backend.put('INBOX', [message(1, 'Brand new')]);
        const after = await syncIndex(db, backend, { now: AT('2026-08-06T13:00:00Z') });

        expect(after.folders[0].rebuilt).toBe(true);
        expect(searchIndex(db, { query: 'Old' }).length).toBe(0);
        expect(searchIndex(db, { query: 'Brand' }).length).toBe(1);
        expect(searchIndex(db, {}).length).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  await describe('expunges and flag drift', async () => {
    await it('removes messages that no longer exist on the server', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'Keep'), message(2, 'Delete me'), message(3, 'Keep too')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        backend.messages.set(
          'INBOX',
          (backend.messages.get('INBOX') ?? []).filter((m) => m.uid !== 2),
        );
        const after = await syncIndex(db, backend, { fullScan: true, now: AT('2026-08-06T13:00:00Z') });
        expect(after.removed).toBe(1);
        expect(searchIndex(db, { query: 'Delete' }).length).toBe(0);
        expect(searchIndex(db, {}).length).toBe(2);
      } finally {
        db.close();
      }
    });

    await it('FORCES the full pass when the message count dropped', async () => {
      // A shrinking `exists` is proof of an expunge, so waiting for the periodic scan would
      // leave the index serving a deleted message — possibly for hours.
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'One'), message(2, 'Two')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        backend.messages.set(
          'INBOX',
          (backend.messages.get('INBOX') ?? []).filter((m) => m.uid !== 1),
        );
        // Ten minutes later — nowhere near the 6-hour interval.
        const after = await syncIndex(db, backend, { now: AT('2026-08-06T12:10:00Z') });
        expect(after.folders[0].skipped).toBe(false);
        expect(after.removed).toBe(1);
      } finally {
        db.close();
      }
    });

    await it('picks up a flag change without touching the body', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'Unread')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        expect(searchIndex(db, { unseen: true }).length).toBe(1);

        const msgs = backend.messages.get('INBOX') ?? [];
        msgs[0].seen = true;
        msgs[0].flagged = true;
        const after = await syncIndex(db, backend, { fullScan: true, now: AT('2026-08-06T13:00:00Z') });

        expect(after.updated).toBe(1);
        expect(after.added).toBe(0);
        expect(searchIndex(db, { unseen: true }).length).toBe(0);
        expect(searchIndex(db, { flagged: true }).length).toBe(1);
        // The body is still indexed — a flag change must not disturb the FTS row.
        expect(searchIndex(db, { query: 'body' }).length).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  await describe('resilience', async () => {
    await it('keeps a folder that vanished from LIST, but stops syncing it', async () => {
      // A transient LIST failure must never be able to empty the index; deleting is an explicit
      // decision, not a side effect of one bad response.
      const db = freshDb();
      const backend = new FakeBackend();
      backend.folders = [folder('INBOX', 'INBOX', 'inbox'), folder('Projekte')];
      backend.put('INBOX', [message(1, 'In inbox')]);
      backend.put('Projekte', [message(2, 'In projekte')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        expect(searchIndex(db, {}).length).toBe(2);

        backend.folders = [folder('INBOX', 'INBOX', 'inbox')];
        await syncIndex(db, backend, { now: AT('2026-08-06T13:00:00Z') });

        expect(searchIndex(db, { query: 'projekte' }).length).toBe(1);
        const status = syncStatus(db, 24, new Date('2026-08-06T13:00:00Z'));
        expect(status.folders).toBe(1); // only INBOX is still sync-enabled
      } finally {
        db.close();
      }
    });

    await it('reports a failing folder without losing the others', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.folders = [folder('INBOX', 'INBOX', 'inbox'), folder('Broken')];
      backend.put('INBOX', [message(1, 'Fine')]);
      const connect = backend.connect.bind(backend);
      backend.connect = async () => {
        const session = await connect();
        const openFolder = session.openFolder.bind(session);
        session.openFolder = async (path: string) => {
          if (path === 'Broken') throw new Error('SELECT Broken failed');
          return openFolder(path);
        };
        return session;
      };
      try {
        const result = await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        expect(result.errors).toBe(1);
        expect(result.failed).toBe(false); // not every folder failed
        expect(result.added).toBe(1);
        expect(searchIndex(db, { query: 'Fine' }).length).toBe(1);
      } finally {
        db.close();
      }
    });

    await it('closes the session even when a folder throws', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.folders = [folder('Broken')];
      const connect = backend.connect.bind(backend);
      backend.connect = async () => {
        const session = await connect();
        session.openFolder = async () => {
          throw new Error('nope');
        };
        return session;
      };
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        expect(backend.closed).toBe(1);
      } finally {
        db.close();
      }
    });

    await it('skips Trash, Junk and All Mail by default', async () => {
      // All Mail is the load-bearing exclusion: it holds a copy of every message, so indexing
      // it would duplicate the entire mailbox.
      const db = freshDb();
      const backend = new FakeBackend();
      backend.folders = [
        folder('INBOX', 'INBOX', 'inbox'),
        folder('Trash', 'Trash', 'trash'),
        folder('All', 'All Mail', 'all'),
      ];
      backend.put('INBOX', [message(1, 'Real')]);
      backend.put('Trash', [message(2, 'Deleted')]);
      backend.put('All', [message(3, 'Duplicate')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        expect(searchIndex(db, {}).length).toBe(1);
        expect(searchIndex(db, { query: 'Real' }).length).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  await describe('syncStatus', async () => {
    await it('reports counts and which folders are stale', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', [message(1, 'One')]);
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });

        const fresh = syncStatus(db, 24, new Date('2026-08-06T13:00:00Z'));
        expect(fresh.messages).toBe(1);
        expect(fresh.accounts).toBe(1);
        expect(fresh.staleFolders.length).toBe(0);

        // Two days later the same folder is stale, which is what makes a search say so.
        const stale = syncStatus(db, 24, new Date('2026-08-08T13:00:00Z'));
        expect(stale.staleFolders.length).toBe(1);
        expect(stale.staleFolders[0].path).toBe('INBOX');
      } finally {
        db.close();
      }
    });
  });

  // `curlew sync` timed out on every run for a folder of ~60 000 rows whose cursor had been reset
  // to 0 by an upgrade: the pass restarted at UID 0 each time and the cursor was only written
  // after the whole pass, so a killed run never got anywhere.
  await describe('a pass that is killed, and a cursor an upgrade reset', async () => {
    /** Wrap the fake so `fetchNewer` fails from its `failAfter`-th call on, recording each start. */
    const killable = (backend: FakeBackend, failAfter: number, starts: number[]) => {
      const connect = backend.connect;
      let calls = 0;
      backend.connect = async () => {
        const session = await connect();
        const fetchNewer = session.fetchNewer;
        session.fetchNewer = async (path, afterUid, batchSize) => {
          starts.push(afterUid);
          if (++calls > failAfter) throw new Error('killed');
          return fetchNewer(path, afterUid, batchSize);
        };
        return session;
      };
    };
    const rows = (n: number) => Array.from({ length: n }, (_, i) => message(i + 1, `Betreff ${i}`));
    const cursorOf = (db: ReturnType<typeof freshDb>) =>
      db.prepare('SELECT uid_validity, uid_next, last_uid, message_count FROM folders').get() as {
        uid_validity: number | null;
        uid_next: number | null;
        last_uid: number;
        message_count: number | null;
      };

    await it('keeps the resume point of a killed pass and continues there', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', rows(10));
      const starts: number[] = [];
      killable(backend, 2, starts);
      try {
        const killed = await syncIndex(db, backend, { batchSize: 3, now: AT('2026-08-06T12:00:00Z') });
        expect(killed.errors).toBe(1);
        const cursor = cursorOf(db);
        expect(cursor.last_uid).toBe(6);
        expect(cursor.uid_validity).toBe(1);
        // Not caught up yet: a recorded uidNext would let the next run skip the folder as unchanged.
        expect(cursor.uid_next).toBe(null);

        const resumed = new FakeBackend();
        resumed.put('INBOX', rows(10));
        const afterStarts: number[] = [];
        killable(resumed, 99, afterStarts);
        const second = await syncIndex(db, resumed, { batchSize: 3, now: AT('2026-08-06T12:10:00Z') });
        expect(afterStarts[0]).toBe(6);
        expect(second.added).toBe(4);
        expect(second.errors).toBe(0);
        expect(db.prepare('SELECT uid FROM messages').all().length).toBe(10);
        expect(cursorOf(db).uid_next).toBe(11);
      } finally {
        db.close();
      }
    });

    await it('re-fetches a folder an upgrade reset, resuming a killed pass', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', rows(10));
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        // What the v2/v11 upgrades do to every folder, on purpose: every row is fetched again.
        db.exec('UPDATE folders SET last_uid = 0, uid_next = NULL, message_count = NULL');
        const starts: number[] = [];
        killable(backend, 2, starts);
        const killed = await syncIndex(db, backend, { batchSize: 3, now: AT('2026-08-07T12:00:00Z') });
        expect(starts[0]).toBe(0);
        expect(killed.errors).toBe(1);
        expect(cursorOf(db).last_uid).toBe(6);

        const resumed = new FakeBackend();
        resumed.put('INBOX', rows(10));
        const afterStarts: number[] = [];
        killable(resumed, 99, afterStarts);
        const second = await syncIndex(db, resumed, { batchSize: 3, now: AT('2026-08-07T12:10:00Z') });
        expect(afterStarts[0]).toBe(6);
        expect(second.errors).toBe(0);
        expect(db.prepare('SELECT uid FROM messages').all().length).toBe(10);
        expect(cursorOf(db).uid_next).toBe(11);
      } finally {
        db.close();
      }
    });

    await it('starts over when the UIDVALIDITY changed behind a lost cursor', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', rows(10));
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        db.exec('UPDATE folders SET last_uid = 0, uid_next = NULL, message_count = NULL');
        backend.uidValidity = 2;
        backend.put('INBOX', rows(4));
        const again = await syncIndex(db, backend, { now: AT('2026-08-07T12:00:00Z') });
        expect(again.folders[0].rebuilt).toBe(true);
        expect(again.added).toBe(4);
        expect(db.prepare('SELECT uid FROM messages').all().length).toBe(4);
        expect(cursorOf(db).uid_validity).toBe(2);
      } finally {
        db.close();
      }
    });

    await it('re-fetches from 0 when the cursor never knew its UIDVALIDITY', async () => {
      const db = freshDb();
      const backend = new FakeBackend();
      backend.put('INBOX', rows(10));
      try {
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        db.exec(
          'UPDATE folders SET last_uid = 0, uid_next = NULL, message_count = NULL, uid_validity = NULL',
        );
        const starts: number[] = [];
        killable(backend, 99, starts);
        const again = await syncIndex(db, backend, { now: AT('2026-08-07T12:00:00Z') });
        expect(starts[0]).toBe(0);
        expect(again.added).toBe(10);
        expect(cursorOf(db).uid_validity).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  await describe('a full resync of a large folder', async () => {
    await it(
      'completes, and every read afterwards is complete',
      async () => {
        // The v2 upgrade resets every cursor, so the next sync re-fetches whole folders. On
        // gjsify's sqlite each execution used to leak a GWeakRef (gjsify#1838); at ~15 executions
        // a message the old one-row-at-a-time writes broke the index after ~5 400 messages, and
        // every SELECT then returned []. 6 000 fetched twice is 12 000 upserts — far past that
        // point — in one process. It still earns its keep: the batched writes are an
        // OPTIMISATION now, and a regression to one `run()` per row has to be slow enough to
        // notice, not fatal.
        const n = 6000;
        const db = freshDb();
        const backend = new FakeBackend();
        backend.put(
          'INBOX',
          Array.from({ length: n }, (_, i) => message(i + 1, `Betreff ${i}`, `Text ${i}`)),
        );
        try {
          const first = await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
          expect(first.added).toBe(n);
          db.exec('UPDATE folders SET last_uid = 0, uid_next = NULL, message_count = NULL');
          const again = await syncIndex(db, backend, { now: AT('2026-08-07T12:00:00Z') });
          expect(again.added).toBe(n);
          expect(again.errors).toBe(0);

          expect(db.prepare('SELECT uid FROM messages').all().length).toBe(n);
          expect(db.prepare('SELECT rowid FROM messages_fts').all().length).toBe(n);
          expect(searchIndex(db, { query: 'Betreff', limit: 100 }).length).toBe(100);
          expect(searchIndex(db, { query: `Text ${n - 1}`, limit: 5 }).length).toBe(1);
        } finally {
          db.close();
        }
      },
      { timeout: 300_000 },
    );
  });
};
