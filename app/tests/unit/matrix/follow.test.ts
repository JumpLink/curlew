import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DeliveryProgress } from '@curlew/store';
import { readChanges, SecretStore, takeReceiveLease } from '@curlew/store';
import {
  accountIdFor,
  connectMatrixClient,
  MatrixBackend,
  MatrixLoggedOutError,
  readOnlyFetch,
  ReadOnlyViolation,
  SYNC_POLL_TIMEOUT_MS,
} from '@curlew/matrix';
import type { MatrixLive } from '@curlew/matrix';

import { followAccount } from '../../../src/core/actions/follow.ts';
import { runDeliveryDaemon } from '../../../src/core/actions/daemon.ts';
import { freshDb } from '../store/fixtures.ts';
import { ANNA, FakeMatrixApi, ME, seedAccount, text } from './fake-api.ts';

/**
 * Matrix follow mode (ADR 0007 §5): the loop around a held connection, and — against a fake
 * homeserver behind the real SDK — what that connection puts on the wire. All data is synthetic.
 */

const T0 = Date.parse('2026-09-01T10:00:00Z');
const at = (seconds: number): number => T0 + seconds * 1000;
const ROOM = '!dm:example.org';
const NO_CONFIG = join(tmpdir(), 'curlew-matrix-follow-test-no-config', 'config.json');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'curlew-matrix-follow-'));
}

async function until(done: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

/** A fake client whose sync loop the test drives: `arrive` is a new event, `end` the loop giving up. */
class LiveFake extends FakeMatrixApi {
  private readonly arrivals = new Set<() => void>();
  private readonly closers: Array<(end: { reason: string; loggedOut: boolean }) => void> = [];
  readonly live: MatrixLive = {
    onArrival: (listener) => {
      this.arrivals.add(listener);
      return () => this.arrivals.delete(listener);
    },
    onClosed: (listener) => {
      this.closers.push(listener);
    },
  };

  arrive(): void {
    for (const listener of this.arrivals) listener();
  }

  end(reason: string, loggedOut = false): void {
    for (const listener of this.closers) listener({ reason, loggedOut });
  }
}

function seeded(): {
  dir: string;
  accountId: string;
  api: LiveFake;
  backend: MatrixBackend;
  opened: LiveFake[];
} {
  const dir = tempDir();
  const accountId = seedAccount(dir);
  const api = new LiveFake();
  api.addRoom({
    roomId: ROOM,
    name: 'Anna Example',
    direct: true,
    members: [{ userId: ANNA, displayName: 'Anna Example' }],
  });
  api.post(ROOM, text(ANNA, at(1), 'Hallo'));
  const opened: LiveFake[] = [];
  const backend = new MatrixBackend({ settings: {}, env: {}, secretsDir: dir }, async () => {
    opened.push(api);
    return api;
  });
  return { dir, accountId, api, backend, opened };
}

function follow(
  fixture: ReturnType<typeof seeded>,
  controller: AbortController,
  extra: Partial<Parameters<typeof followAccount>[0]> = {},
) {
  const events: DeliveryProgress[] = [];
  const logs: string[] = [];
  const db = extra.db ?? freshDb();
  const running = followAccount({
    db,
    backend: fixture.backend,
    backendName: 'matrix',
    accountId: fixture.accountId,
    open: (id) => fixture.backend.connectLive(id),
    permit: { account: fixture.accountId, addresses: [] },
    signal: controller.signal,
    log: (line) => logs.push(line),
    onWrite: () => {},
    onProgress: (event) => events.push(event),
    holder: 'pid-me',
    leaseIntervalMs: 1000,
    minGapMs: 0,
    sleep: async () => {},
    ...extra,
  });
  return { running, events, logs, db };
}

// --- the fake homeserver behind the real SDK ---------------------------------------------------

interface Hit {
  method: string;
  url: URL;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Just enough homeserver for `startClient`: every route answers with the least the SDK accepts,
 * `/sync` is scripted (a queue of replies, then a long poll that ends when the client aborts it).
 */
function homeserver(script: Array<(hit: Hit) => Response>) {
  const hits: Hit[] = [];
  const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const hit = { method, url };
    hits.push(hit);
    const path = url.pathname;
    if (path.endsWith('/sync')) {
      const next = script.shift();
      if (next) return next(hit);
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const stop = (): void => reject(new DOMException('aborted', 'AbortError'));
        if (signal?.aborted) stop();
        else signal?.addEventListener('abort', stop, { once: true });
      });
    }
    if (path.endsWith('/versions')) return json({ versions: ['v1.11'], unstable_features: {} });
    if (path.endsWith('/filter')) return json({ filter_id: 'f1' });
    if (path.endsWith('/pushrules/')) return json({ global: {} });
    if (path.endsWith('/keys/upload')) return json({ one_time_key_counts: { signed_curve25519: 50 } });
    if (path.endsWith('/keys/query')) return json({ device_keys: {}, failures: {} });
    if (path.includes('/room_keys/version')) {
      return new Response(JSON.stringify({ errcode: 'M_NOT_FOUND', error: 'No backup' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return json({});
  }) as typeof globalThis.fetch;
  return { fetch, hits, syncs: () => hits.filter((h) => h.url.pathname.endsWith('/sync')) };
}

const reply =
  (nextBatch: string, join: Record<string, unknown> = {}) =>
  (): Response =>
    json({
      next_batch: nextBatch,
      rooms: { join },
      device_one_time_keys_count: { signed_curve25519: 50 },
    });

const roomWith = (events: unknown[]) => ({
  [ROOM]: {
    state: {
      events: [
        {
          type: 'm.room.member',
          state_key: ME,
          sender: ME,
          event_id: '$m1:example.org',
          origin_server_ts: at(0),
          content: { membership: 'join', displayname: 'Me' },
        },
      ],
    },
    timeline: { events, limited: false, prev_batch: 'p0' },
  },
});

async function sdkConnection(dir: string, fetch: typeof globalThis.fetch) {
  const store = SecretStore.open(join(dir, 'sdk.db'));
  const api = await connectMatrixClient({
    homeserver: 'https://matrix.example.org',
    userId: ME,
    deviceId: 'DEVICE',
    accessToken: 'synthetic-token',
    store,
    accountId: accountIdFor(ME),
    fetch,
  });
  return { api, store };
}

export default async () => {
  await describe('Matrix follow loop', async () => {
    await it('writes what arrives through the sync path, with its journal row, and reports connected', async () => {
      const fixture = seeded();
      const controller = new AbortController();
      try {
        const { running, events, db } = follow(fixture, controller);
        await until(() => events.some((e) => e.type === 'connected'));
        // The first catch-up is the ordinary history walk: the message that was already there.
        await until(() => readChanges(db, 0).changes.some((c) => c.kind === 'messages'));
        const before = readChanges(db, 0).changes.length;
        expect(before > 0).toBe(true);

        fixture.api.post(ROOM, text(ANNA, at(30), 'Neu'));
        fixture.api.arrive();
        await until(() => readChanges(db, 0).changes.length > before);
        const after = readChanges(db, 0);
        expect(after.changes.length > before).toBe(true);
        expect(after.changes.every((c) => c.backend === 'matrix' && c.accountId === fixture.accountId)).toBe(
          true,
        );
        const stored = db.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get() as { n: number };
        expect(Number(stored.n)).toBe(2);

        controller.abort();
        const result = await running;
        expect(result.added).toBe(2);
        expect(result.loggedOut).toBe(false);
        // The held connection is closed exactly once, at the end; the catch-ups never close it.
        expect(fixture.api.closed).toBe(1);
        expect(events.some((e) => e.type === 'stopped')).toBe(true);
        expect(events.every((e) => e.backend === 'matrix')).toBe(true);
      } finally {
        controller.abort();
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    });

    await it('opens the connection again after the sync loop gave up, and waits first', async () => {
      const fixture = seeded();
      const controller = new AbortController();
      const waits: number[] = [];
      try {
        const { running, events } = follow(fixture, controller, {
          sleep: async (ms) => {
            waits.push(ms);
          },
        });
        await until(() => fixture.opened.length === 1);
        fixture.api.end('HTTP 502');
        await until(() => fixture.opened.length === 2);
        expect(fixture.opened.length).toBe(2);
        const reconnect = events.find((e) => e.type === 'reconnect');
        expect(reconnect !== undefined).toBe(true);
        expect(waits.includes(5000)).toBe(true);
        expect(events.filter((e) => e.type === 'connected').length >= 1).toBe(true);
        controller.abort();
        await running;
      } finally {
        controller.abort();
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    });

    await it('stops a logged-out account and does not retry', async () => {
      const fixture = seeded();
      const controller = new AbortController();
      try {
        const { running, events, logs } = follow(fixture, controller);
        await until(() => fixture.opened.length === 1);
        fixture.api.end('M_UNKNOWN_TOKEN', true);
        const result = await running;
        expect(result.loggedOut).toBe(true);
        expect(fixture.opened.length).toBe(1);
        expect(events.some((e) => e.type === 'logged-out')).toBe(true);
        const last = events[events.length - 1];
        expect(last.type === 'stopped' && last.reason === 'logged-out').toBe(true);
        expect(logs.some((l) => l.includes('logged out'))).toBe(true);
        // The lease is given back, so a `sync` or a relinked daemon can take the account.
        const held = fixture.api.closed;
        expect(held).toBe(1);
      } finally {
        controller.abort();
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    });

    await it('treats a refused first connect (M_UNKNOWN_TOKEN) as logged out as well', async () => {
      const fixture = seeded();
      const controller = new AbortController();
      let calls = 0;
      try {
        const backend = new MatrixBackend({ settings: {}, env: {}, secretsDir: fixture.dir }, async () => {
          calls += 1;
          throw Object.assign(new Error('M_UNKNOWN_TOKEN: unknown token'), { errcode: 'M_UNKNOWN_TOKEN' });
        });
        let thrown: unknown = null;
        try {
          await backend.connectLive(fixture.accountId);
        } catch (err) {
          thrown = err;
        }
        expect(thrown instanceof MatrixLoggedOutError).toBe(true);
        expect((thrown as Error).message.includes('curlew accounts add matrix')).toBe(true);

        const { running, events } = follow({ ...fixture, backend }, controller);
        const result = await running;
        expect(result.loggedOut).toBe(true);
        expect(calls).toBe(2);
        expect(events.some((e) => e.type === 'logged-out')).toBe(true);
      } finally {
        controller.abort();
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    });

    await it('ends promptly on abort and gives the connection and the lease back', async () => {
      const fixture = seeded();
      const controller = new AbortController();
      try {
        const { running, db } = follow(fixture, controller, { sleep: undefined });
        await until(() => fixture.opened.length === 1);
        const started = Date.now();
        controller.abort();
        await running;
        expect(Date.now() - started < 1000).toBe(true);
        expect(fixture.api.closed).toBe(1);
        const lease = db
          .prepare('SELECT holder FROM receive_leases WHERE account_id = ?')
          .get(fixture.accountId);
        expect(lease === undefined || lease === null).toBe(true);
      } finally {
        controller.abort();
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    });

    await it('does not connect while another process holds the account', async () => {
      const fixture = seeded();
      const controller = new AbortController();
      const db = freshDb();
      try {
        takeReceiveLease(db, 'matrix', fixture.accountId, 'pid-other', new Date(), 60_000);
        const { running, events } = follow(fixture, controller, {
          db,
          leaseIntervalMs: 20,
          sleep: undefined,
        });
        await until(() => events.some((e) => e.type === 'lease-waiting'));
        expect(events.some((e) => e.type === 'lease-waiting')).toBe(true);
        expect(fixture.opened.length).toBe(0);
        controller.abort();
        await running;
      } finally {
        controller.abort();
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    });
  });

  await describe('Matrix daemon follow', async () => {
    await it('follows an enabled account next to nothing else, and the run ends on the signal', async () => {
      const fixture = seeded();
      const controller = new AbortController();
      const logs: string[] = [];
      try {
        const run = runDeliveryDaemon({
          dbPath: ':memory:',
          configPath: NO_CONFIG,
          backends: [],
          matrix: fixture.backend,
          signal: controller.signal,
          rebuildDebounceMs: 5,
          changePollMs: 5,
          log: (line) => logs.push(line),
          rebuild: async () => ({ conversations: 0, participants: 0, contacts: null }) as never,
          publishSend: null,
        });
        await until(() => logs.some((l) => l.includes('catch-up wrote 1 added')));
        controller.abort();
        const result = await run;
        expect(result.followed.length).toBe(1);
        expect(result.followed[0].added).toBe(1);
        expect(result.accounts[0].backend).toBe('matrix');
        expect(result.accounts[0].loggedOut).toBe(false);
        // The log-line rule: no room id, no peer, no text.
        const joined = logs.join('\n');
        expect(joined.includes(ROOM)).toBe(false);
        expect(joined.includes('Hallo')).toBe(false);
        expect(joined.includes(ANNA)).toBe(false);
      } finally {
        controller.abort();
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    });
  });

  await describe('Matrix follow on the wire', async () => {
    await it('long-polls /sync with set_presence=offline, advances the token, wakes on an event', async () => {
      const dir = tempDir();
      const event = {
        type: 'm.room.message',
        event_id: '$e1:example.org',
        sender: ANNA,
        origin_server_ts: at(40),
        content: { msgtype: 'm.text', body: 'Neu' },
      };
      const hs = homeserver([
        reply('s1', roomWith([])),
        reply('s2'),
        reply('s3'),
        reply('s4', roomWith([event])),
      ]);
      let connection: Awaited<ReturnType<typeof sdkConnection>> | null = null;
      try {
        connection = await sdkConnection(dir, hs.fetch);
        const live = connection.api.live;
        expect(live !== undefined).toBe(true);
        let woken = 0;
        live?.onArrival(() => {
          woken += 1;
        });
        await until(() => woken > 0, 5000);
        expect(woken > 0).toBe(true);

        const syncs = hs.syncs();
        expect(syncs.length >= 4).toBe(true);
        // Never online; and once it is happily syncing, a real long poll rather than a short loop.
        expect(syncs.every((h) => h.url.searchParams.get('set_presence') === 'offline')).toBe(true);
        expect(syncs.some((h) => h.url.searchParams.get('timeout') === String(SYNC_POLL_TIMEOUT_MS))).toBe(
          true,
        );
        // The token the server handed out is the one the next request carries.
        expect(syncs[0].url.searchParams.get('since')).toBe(null);
        expect(syncs[1].url.searchParams.get('since')).toBe('s1');
        expect(syncs[2].url.searchParams.get('since')).toBe('s2');
        // A follow reads and never writes beyond the E2EE protocol the gate allows.
        const writes = hs.hits.filter((h) => h.method !== 'GET' && h.method !== 'HEAD');
        const allowed = /\/(keys\/(upload|query|claim)|user\/[^/]+\/filter|sendToDevice\/[^/]+\/[^/]+)$/;
        expect(writes.every((h) => allowed.test(h.url.pathname))).toBe(true);
        expect(hs.hits.some((h) => h.url.pathname.includes('/presence/'))).toBe(false);
        expect(hs.hits.some((h) => h.url.pathname.includes('/receipt/'))).toBe(false);
        expect(hs.hits.some((h) => h.url.pathname.includes('/send/'))).toBe(false);
      } finally {
        await connection?.api.close().catch(() => {});
        connection?.store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('reports a dead token as logged out, and the sync stops', async () => {
      const dir = tempDir();
      const hs = homeserver([
        reply('s1', roomWith([])),
        reply('s2'),
        () => json({ errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown token', soft_logout: false }, 401),
      ]);
      let connection: Awaited<ReturnType<typeof sdkConnection>> | null = null;
      try {
        connection = await sdkConnection(dir, hs.fetch);
        let end: { reason: string; loggedOut: boolean } | null = null;
        connection.api.live?.onClosed((e) => {
          end = e;
        });
        await until(() => end !== null, 5000);
        expect(end !== null).toBe(true);
        const closed = end as unknown as { reason: string; loggedOut: boolean };
        expect(closed.loggedOut).toBe(true);
        expect(closed.reason).toBe('M_UNKNOWN_TOKEN');
        const count = hs.syncs().length;
        await new Promise((r) => setTimeout(r, 200));
        expect(hs.syncs().length).toBe(count);
      } finally {
        await connection?.api.close().catch(() => {});
        connection?.store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('stops the long poll when the connection is closed', async () => {
      const dir = tempDir();
      const hs = homeserver([reply('s1', roomWith([])), reply('s2'), reply('s3')]);
      let connection: Awaited<ReturnType<typeof sdkConnection>> | null = null;
      try {
        connection = await sdkConnection(dir, hs.fetch);
        await until(() => hs.syncs().length >= 4, 5000);
        const started = Date.now();
        await connection.api.close();
        expect(Date.now() - started < 2000).toBe(true);
        const count = hs.syncs().length;
        await new Promise((r) => setTimeout(r, 200));
        expect(hs.syncs().length).toBe(count);
      } finally {
        connection?.store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('keeps the gate shut for a write and for a /sync that would mark the user online', async () => {
      const seen: string[] = [];
      const guarded = readOnlyFetch((async (input: unknown) => {
        seen.push(String(input));
        return json({});
      }) as typeof globalThis.fetch);
      const hs = 'https://matrix.example.org/_matrix/client/v3';
      for (const [method, url] of [
        ['PUT', `${hs}/rooms/!r:example.org/send/m.room.message/t1`],
        ['PUT', `${hs}/presence/@me:example.org/status`],
        ['POST', `${hs}/rooms/!r:example.org/read_markers`],
        ['GET', `${hs}/sync?timeout=30000`],
      ]) {
        let error: unknown = null;
        try {
          await guarded(url, { method });
        } catch (err) {
          error = err;
        }
        expect(error instanceof ReadOnlyViolation).toBe(true);
      }
      expect(seen.length).toBe(0);
      await guarded(`${hs}/sync?timeout=30000&set_presence=offline`);
      expect(seen.length).toBe(1);
    });
  });
};
