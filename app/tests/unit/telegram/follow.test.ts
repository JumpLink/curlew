import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BackendContext } from '@curlew/protocol';
import type { DeliveryProgress } from '@curlew/store';
import { takeReceiveLease } from '@curlew/store';
import { mtcuteLive, sessionGone, TelegramBackend } from '@curlew/telegram';

import { followAccount } from '../../../src/core/actions/follow.ts';
import { runDeliveryDaemon } from '../../../src/core/actions/daemon.ts';
import { freshDb } from '../store/fixtures.ts';
import { fakeFactory, type FakeClient, ME, tgMessage, user } from './fake-client.ts';

/**
 * Telegram follow mode: updates are only a wake-up, the read-only chat sync writes, the lease is
 * held per account. A fake client with synthetic chats; no network, no account.
 */

const ANNA = user(1001, 'Anna Example');
const ACCOUNT = 'telegram-42';
const NO_CONFIG = join(tmpdir(), 'curlew-telegram-follow-test-no-config', 'config.json');

const prompter = () => {
  const queue = ['+49 170 0000000', '12345', 'correct horse'];
  return { ask: async () => queue.shift() ?? '', notify: () => {} };
};

async function until(done: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

async function rig(
  body: (r: { dir: string; backend: TelegramBackend; clients: FakeClient[] }) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-telegram-follow-'));
  try {
    const context: BackendContext = {
      settings: {},
      env: { CURLEW_TELEGRAM_API_ID: '12345', CURLEW_TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef' },
      secretsDir: join(dir, 'secrets', 'telegram'),
    };
    const history = new Map([[ANNA.id, [tgMessage(ANNA, 1, ANNA, 'Hallo')]]]);
    const fake = fakeFactory({
      dialogs: [
        { peer: ANNA, lastMessage: history.get(ANNA.id)![0], lastReadIngoing: 0, lastReadOutgoing: 0 },
      ],
      history,
    });
    const backend = new TelegramBackend(context, fake.create);
    await backend.addAccount(prompter());
    fake.clients.length = 0;
    await body({ dir, backend, clients: fake.clients });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** mtcute's emitter, as far as `mtcuteLive` uses it. */
function emitter<T>() {
  const listeners: Array<(value: T) => void> = [];
  return {
    add: (l: (value: T) => void) => void listeners.push(l),
    emit: (v: T) => listeners.forEach((l) => l(v)),
  };
}

export default async () => {
  await describe('Telegram live updates', async () => {
    await it('reads a revoked session as gone, and nothing else', () => {
      expect(sessionGone({ text: 'AUTH_KEY_UNREGISTERED' })).toBe('AUTH_KEY_UNREGISTERED');
      expect(sessionGone({ text: 'USER_DEACTIVATED_BAN' })).toBe('USER_DEACTIVATED_BAN');
      expect(sessionGone({ text: 'FLOOD_WAIT_%d' })).toBe(null);
      expect(sessionGone(new Error('AUTH_KEY_UNREGISTERED'))).toBe(null);
    });

    await it('wakes on an update, and closes only after the connection stayed offline', async () => {
      const onUpdate = emitter<unknown>();
      const onConnectionState = emitter<string>();
      const onError = emitter<unknown>();
      const live = mtcuteLive(
        { onUpdate, onConnectionState, onError, startUpdatesLoop: async () => {} } as never,
        20,
      );
      let woke = 0;
      const ends: string[] = [];
      live.onArrival(() => woke++);
      live.onClosed((end) => ends.push(`${end.reason}:${end.loggedOut}`));
      onUpdate.emit({});
      expect(woke).toBe(1);
      // A short drop that recovers closes nothing: mtcute reconnects on its own.
      onConnectionState.emit('offline');
      onConnectionState.emit('connected');
      await new Promise((r) => setTimeout(r, 40));
      expect(ends.length).toBe(0);
      onConnectionState.emit('offline');
      await until(() => ends.length > 0);
      expect(ends.join()).toBe('offline:false');
    });

    await it('closes as logged out when Telegram says the session is gone', () => {
      const onError = emitter<unknown>();
      const live = mtcuteLive(
        {
          onUpdate: emitter(),
          onConnectionState: emitter(),
          onError,
          startUpdatesLoop: async () => {},
        } as never,
        20,
      );
      const ends: string[] = [];
      live.onClosed((end) => ends.push(`${end.reason}:${end.loggedOut}`));
      onError.emit({ text: 'SESSION_REVOKED' });
      onError.emit({ text: 'SESSION_REVOKED' });
      expect(ends.join()).toBe('SESSION_REVOKED:true');
    });
  });

  await describe('Telegram follow', async () => {
    await it('opens a live client, catches up, and catches up again on an update', async () => {
      await rig(async ({ dir, backend, clients }) => {
        const controller = new AbortController();
        const db = freshDb();
        const events: DeliveryProgress[] = [];
        const logs: string[] = [];
        const running = followAccount({
          db,
          backend,
          backendName: 'telegram',
          accountId: ACCOUNT,
          open: (id) => backend.connectLive(id),
          permit: { account: ACCOUNT, addresses: [] },
          signal: controller.signal,
          log: (line) => logs.push(line),
          onWrite: () => {},
          onProgress: (event) => events.push(event),
          holder: 'pid-me',
          leaseIntervalMs: 1000,
          minGapMs: 0,
          sleep: async () => {},
        });
        await until(() => logs.some((l) => l.includes('catch-up wrote 1 added')));
        expect(clients.length).toBe(1);
        expect(clients[0].liveStarts).toBe(1);
        expect(clients[0].sent.length).toBe(0);
        clients[0].arrive();
        await until(() => logs.filter((l) => l.includes('catch-up wrote')).length >= 2);
        expect(logs.filter((l) => l.includes('catch-up wrote')).length >= 2).toBe(true);
        controller.abort();
        const result = await running;
        expect(result.added).toBe(1);
        expect(clients[0].destroyed).toBeGreaterThan(0);
        expect(logs.join('\n').includes('Hallo')).toBe(false);
        expect(dir.length).toBeGreaterThan(0);
      });
    });

    await it('reconnects when the connection ends, and stops an account Telegram logged out', async () => {
      await rig(async ({ backend, clients }) => {
        const controller = new AbortController();
        const logs: string[] = [];
        const running = followAccount({
          db: freshDb(),
          backend,
          backendName: 'telegram',
          accountId: ACCOUNT,
          open: (id) => backend.connectLive(id),
          permit: { account: ACCOUNT, addresses: [] },
          signal: controller.signal,
          log: (line) => logs.push(line),
          onWrite: () => {},
          holder: 'pid-me',
          leaseIntervalMs: 1000,
          minGapMs: 0,
          sleep: async () => {},
        });
        await until(() => clients.length === 1 && logs.some((l) => l.endsWith('connected')));
        clients[0].end('offline');
        await until(() => clients.length === 2);
        expect(clients.length).toBe(2);
        await until(() => logs.filter((l) => l.endsWith('connected')).length === 2);
        clients[1].end('SESSION_REVOKED', true);
        const result = await running;
        expect(result.loggedOut).toBe(true);
        controller.abort();
      });
    });

    await it('does not connect while another process holds the account', async () => {
      await rig(async ({ backend, clients }) => {
        const controller = new AbortController();
        const db = freshDb();
        takeReceiveLease(db, 'telegram', ACCOUNT, 'pid-other', new Date(), 60_000);
        const events: DeliveryProgress[] = [];
        const running = followAccount({
          db,
          backend,
          backendName: 'telegram',
          accountId: ACCOUNT,
          open: (id) => backend.connectLive(id),
          permit: { account: ACCOUNT, addresses: [] },
          signal: controller.signal,
          log: () => {},
          onWrite: () => {},
          onProgress: (event) => events.push(event),
          holder: 'pid-me',
          leaseIntervalMs: 20,
        });
        await until(() => events.some((e) => e.type === 'lease-waiting'));
        expect(events.some((e) => e.type === 'lease-waiting')).toBe(true);
        expect(clients.length).toBe(0);
        controller.abort();
        await running;
      });
    });

    await it('the daemon follows an enabled Telegram account and ends on the signal', async () => {
      await rig(async ({ backend, clients }) => {
        const controller = new AbortController();
        const logs: string[] = [];
        const run = runDeliveryDaemon({
          dbPath: ':memory:',
          configPath: NO_CONFIG,
          backends: [],
          telegram: backend,
          xmpp: null,
          matrix: null,
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
        expect(result.accounts[0].backend).toBe('telegram');
        expect(result.accounts[0].added).toBe(1);
        expect(clients[0].sent.length).toBe(0);
        expect(ME.id).toBe(42);
      });
    });
  });
};
