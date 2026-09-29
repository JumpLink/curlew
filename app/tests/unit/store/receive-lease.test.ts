import { describe, expect, it } from '@gjsify/unit';

import {
  LEASE_HEARTBEAT_MS,
  migrate,
  receiveLeases,
  refreshReceiveLease,
  releaseReceiveLease,
  takeReceiveLease,
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
        const fresh = takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-2', at(LEASE_HEARTBEAT_MS));
        expect(fresh.acquired).toBe(false);
        // Three intervals later it is not, and the takeover succeeds.
        expect(takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-2', at(3 * LEASE_HEARTBEAT_MS)).acquired).toBe(
          true,
        );
        const leases = receiveLeases(db, at(3 * LEASE_HEARTBEAT_MS));
        expect(leases.get(`${BACKEND}/${ACCOUNT}`)).toBe('pid-2');
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
        expect(receiveLeases(db, at(LEASE_HEARTBEAT_MS)).size).toBe(1);
        expect(refreshReceiveLease(db, BACKEND, ACCOUNT, 'pid-1', at(LEASE_HEARTBEAT_MS))).toBe(true);
        // Refreshed at 30 s, it is fresh again well past where it would have expired.
        expect(takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-2', at(3 * LEASE_HEARTBEAT_MS)).acquired).toBe(
          false,
        );
        expect(receiveLeases(db, at(3 * LEASE_HEARTBEAT_MS)).get(`${BACKEND}/${ACCOUNT}`)).toBe('pid-1');
        // Never taken: an account nobody holds is not in the map.
        expect(receiveLeases(db, at(3 * LEASE_HEARTBEAT_MS)).get(`${BACKEND}/wa-9`)).toBeUndefined();
      } finally {
        db.close();
      }
    });

    await it('stops listing a lease once it went stale, so a sync receives that account', async () => {
      const db = freshDb();
      try {
        takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-1', T0);
        expect(receiveLeases(db, at(LEASE_HEARTBEAT_MS)).size).toBe(1);
        expect(receiveLeases(db, at(4 * LEASE_HEARTBEAT_MS)).size).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('releases its own lease only', async () => {
      const db = freshDb();
      try {
        takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-1', T0);
        expect(releaseReceiveLease(db, BACKEND, ACCOUNT, 'pid-2')).toBe(false);
        expect(receiveLeases(db, at(1_000)).size).toBe(1);
        expect(releaseReceiveLease(db, BACKEND, ACCOUNT, 'pid-1')).toBe(true);
        expect(receiveLeases(db, at(1_000)).size).toBe(0);
        // Releasing what is not there is not an error, just nothing to do.
        expect(releaseReceiveLease(db, BACKEND, ACCOUNT, 'pid-1')).toBe(false);
      } finally {
        db.close();
      }
    });

    await it('migrates a v5 index to v6 without touching a stored message', async () => {
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
        expect(version.value).toBe('6');
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
