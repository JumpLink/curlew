import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  BackendAccount,
  BackendManifest,
  ChatMessage,
  DeliveryBackend,
  DeliveryEvent,
  DeliveryOutcome,
  DeliverySession,
} from '@curlew/protocol';
import { PLUGIN_API_VERSION } from '@curlew/protocol';
import type { RebuildResult } from '@curlew/store';
import { takeReceiveLease } from '@curlew/store';
import { accountIdFor } from '@curlew/signal';
import { accountIdFromCreds } from '@curlew/whatsapp';
import { openIndex } from '../../../src/core/actions/index-sync.ts';
import {
  daemonExitCode,
  type DaemonAccountResult,
  runDeliveryDaemon,
} from '../../../src/core/actions/daemon.ts';

/**
 * The daemon action without a network and without a real address book: a scripted delivery
 * backend, an in-memory index, and an injected rebuild so the debounce can be counted. All data
 * is synthetic.
 *
 * What is asserted here is the daemon's own job — one log line per state change and nothing else,
 * a debounced rebuild that collapses a burst, and a clean stop — not the receive path, which
 * `delivery-follow.test.ts` covers against the port.
 */

const BACKEND = 'fakedaemon';

const ANNA_TEXT = 'geheim, aber synthetisch';

function message(id: string, seq: number, text: string): ChatMessage {
  return {
    remoteId: id,
    seq,
    sentAt: new Date(Date.UTC(2026, 0, 1, 12, 0, seq)).toISOString(),
    editedAt: null,
    sender: {
      remoteId: 'anna',
      displayName: 'Anna Example',
      addresses: [{ kind: 'phone', value: '+491510000001' }],
      bot: false,
    },
    fromSelf: false,
    text,
    hasAttachments: false,
    replyToRemoteId: null,
    threadRemoteId: null,
  };
}

const incoming = (m: ChatMessage): DeliveryEvent => ({
  type: 'message',
  chatRemoteId: 'd-anna',
  chatKind: 'direct',
  message: m,
  seen: false,
});

/** A session that stays open until it is closed — a follow session. */
class OpenSession implements DeliverySession {
  private queue: DeliveryEvent[] = [];
  private waiters: Array<() => void> = [];
  private ended = false;
  private result: DeliveryOutcome = { caughtUp: false, error: null };

  push(...events: DeliveryEvent[]): void {
    this.queue.push(...events);
    this.wake();
  }

  /** End the way the network would: the next `nextBatch()` resolves null. */
  end(outcome: DeliveryOutcome): void {
    this.result = outcome;
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  async nextBatch(): Promise<DeliveryEvent[] | null> {
    for (;;) {
      if (this.queue.length > 0) {
        const batch = this.queue;
        this.queue = [];
        return batch;
      }
      if (this.ended) return null;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  outcome(): DeliveryOutcome {
    return this.result;
  }

  async close(): Promise<void> {
    this.ended = true;
    this.wake();
  }
}

class ScriptedBackend implements DeliveryBackend {
  readonly manifest: BackendManifest = {
    name: BACKEND,
    displayName: 'Fake daemon backend',
    pluginApi: PLUGIN_API_VERSION,
    capabilities: {
      edits: true,
      reactions: false,
      threads: false,
      readReceipts: true,
      groups: true,
      e2ee: true,
      subject: false,
      folders: false,
      attachments: true,
    },
    syncModel: 'delivery-only',
    native: false,
    addressKinds: ['phone'],
    terms: null,
  };
  readonly kind = 'delivery' as const;
  readonly sessions = new Map<string, OpenSession>();

  private readonly accountIds: string[];

  constructor(accountIds: string[]) {
    this.accountIds = accountIds;
  }

  async listAccounts(): Promise<BackendAccount[]> {
    return this.accountIds.map((id) => ({ id, identity: id, provider: 'Fake' }));
  }

  async connect(accountId: string): Promise<DeliverySession> {
    const session = new OpenSession();
    this.sessions.set(accountId, session);
    return session;
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
const settle = async () => {
  await tick();
  await tick();
};

const REBUILD: RebuildResult & { contacts: number | null } = {
  conversations: 2,
  messages: 3,
  participants: 2,
  contacts: 41,
};

export default async () => {
  await describe('rebuilds', async () => {
    await it('serialises them and waits for the one in flight before the index closes', async () => {
      const controller = new AbortController();
      const logs: string[] = [];
      let calls = 0;
      let running = 0;
      let peak = 0;
      let open: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const backend = new ScriptedBackend(['a-1']);
      const rebuild = async (): Promise<RebuildResult & { contacts: number | null }> => {
        calls++;
        running++;
        peak = Math.max(peak, running);
        await gate;
        running--;
        return REBUILD;
      };
      try {
        const received = runDeliveryDaemon({
          dbPath: ':memory:',
          backends: [backend],
          signal: controller.signal,
          rebuildDebounceMs: 5,
          log: (line) => logs.push(line),
          rebuild,
        });
        await settle();
        backend.sessions.get('a-1')?.push(incoming(message('a1/1', 1, ANNA_TEXT)));
        for (let i = 0; i < 100 && calls < 1; i++) await new Promise((r) => setTimeout(r, 5));
        expect(calls).toBe(1);
        // A second batch lands while the first rebuild is still running: `dirty` again.
        backend.sessions.get('a-1')?.push(incoming(message('a1/2', 2, 'zwei')));
        await settle();
        controller.abort();
        let settledRun = false;
        void received.then(() => {
          settledRun = true;
        });
        await new Promise((r) => setTimeout(r, 20));
        // The stop must not finish — and must not close the index — under a running rebuild.
        expect(settledRun).toBe(false);
        open();
        const result = await received;
        // Two rebuilds (the debounced one and the one the stop asked for), never overlapping.
        expect(calls).toBe(2);
        expect(peak).toBe(1);
        expect(result.conversations?.contacts).toBe(41);
      } finally {
        open();
        controller.abort();
      }
    });
  });

  await describe('the ids a log line may carry', async () => {
    // ADR 0002 §6 allows the account id in a log line and nothing else identifying. That rests on
    // one invariant of the id derivation: a WhatsApp id is the LID or the registration id, a
    // Signal id is the ACI — never a phone number, never a name. If that ever changes, every log
    // line of the daemon leaks, so it is pinned here with realistic id shapes.
    await it('derives backend ids from opaque network ids, never from a number or a name', async () => {
      expect(accountIdFromCreds({ me: { lid: '123456789012345@lid' }, registrationId: 7 })).toBe(
        'whatsapp-123456789012345',
      );
      // A linked device that has no LID yet falls back to the registration id, not the phone.
      expect(accountIdFromCreds({ registrationId: 3141592653 })).toBe('whatsapp-3141592653');
      const aci = '9d0652a3-dcc3-4d11-975f-74d61598733f';
      expect(accountIdFor(aci)).toBe(`signal-${aci}`);
      // The shapes the daemon actually writes: no '+', no 7-plus-digit run that could be a number.
      for (const id of [accountIdFromCreds({ me: { lid: '123456789012345@lid' } }), accountIdFor(aci)]) {
        expect(id).not.toContain('+');
        expect(id.includes('49151')).toBe(false);
        expect(id.includes('491510000001')).toBe(false);
      }
    });
  });

  await describe('daemonExitCode', async () => {
    // Pure, so the one thing systemd reads out of the process is decided without a process.
    const account = (over: Partial<DaemonAccountResult> = {}): DaemonAccountResult => ({
      backend: 'fakedaemon',
      accountId: 'a-1',
      batches: 3,
      added: 7,
      removed: 0,
      error: null,
      heldBy: null,
      indexBusy: false,
      loggedOut: false,
      ...over,
    });

    await it('is 2 when no account is left receiving and one was logged out', async () => {
      // The WhatsApp 14-day unlink: green and dead unless the exit says otherwise.
      expect(daemonExitCode({ accounts: [account({ loggedOut: true, error: 'logged out' })] })).toBe(2);
      expect(
        daemonExitCode({
          accounts: [
            account({ loggedOut: true, error: 'logged out' }),
            account({ accountId: 'a-2', error: 'the connection closed' }),
          ],
        }),
      ).toBe(2);
    });

    await it('is 0 for a normal stop, and when something still receives', async () => {
      expect(daemonExitCode({ accounts: [account()] })).toBe(0);
      // One account logged out, another still receiving: the daemon is doing its job.
      expect(
        daemonExitCode({
          accounts: [account({ loggedOut: true, error: 'logged out' }), account({ accountId: 'a-2' })],
        }),
      ).toBe(0);
      // Every account dead, but for a reason a restart could get past.
      expect(daemonExitCode({ accounts: [account({ error: 'the connection closed' })] })).toBe(0);
      // No accounts at all is a machine with nothing linked yet, not a logout.
      expect(daemonExitCode({ accounts: [] })).toBe(0);
    });
  });

  await describe('runDeliveryDaemon', async () => {
    await it('receives every account, rebuilds once for a burst and once on stop', async () => {
      const controller = new AbortController();
      const logs: string[] = [];
      let rebuilds = 0;
      const backend = new ScriptedBackend(['a-1', 'a-2']);
      try {
        const running = runDeliveryDaemon({
          dbPath: ':memory:',
          backends: [backend],
          signal: controller.signal,
          rebuildDebounceMs: 10,
          log: (line) => logs.push(line),
          rebuild: async () => {
            rebuilds++;
            return REBUILD;
          },
        });
        await settle();
        // Both accounts at once, and both report in.
        expect([...backend.sessions.keys()].sort().join(',')).toBe('a-1,a-2');
        // A burst: three batches inside one debounce window.
        backend.sessions.get('a-1')?.push(incoming(message('a1/1', 1, ANNA_TEXT)));
        await tick();
        backend.sessions.get('a-1')?.push(incoming(message('a1/2', 2, 'zwei')));
        await tick();
        backend.sessions.get('a-2')?.push(incoming(message('a2/1', 1, 'drei')));
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        // One rebuild for the whole burst, not one per batch.
        expect(rebuilds).toBe(1);
        // One log line per state change, and not a word of what was received.
        const written = logs.filter((l) => l.includes('written'));
        expect(written.length).toBe(3);
        expect(written.every((l) => l.startsWith(`curlew-daemon: ${BACKEND}/`))).toBe(true);
        expect(logs.some((l) => l.includes(ANNA_TEXT))).toBe(false);
        expect(logs.some((l) => l.includes('Anna'))).toBe(false);
        expect(logs.some((l) => l.includes('+49151'))).toBe(false);
        expect(logs.some((l) => l.includes(`${BACKEND}/a-1 connected`))).toBe(true);

        // The stop: SIGTERM only aborts; the run finishes what it started. One last batch lands
        // after the debounced rebuild, so the stop rebuilds once more — a written batch is never
        // left out of the conversations.
        backend.sessions.get('a-2')?.push(incoming(message('a2/2', 2, 'vier')));
        await tick();
        controller.abort();
        const result = await running;
        expect(rebuilds).toBe(2);
        expect(result.added).toBe(4);
        expect(result.errors).toBe(0);
        expect(result.accounts.length).toBe(2);
        expect(result.conversations?.contacts).toBe(41);
        expect(logs.some((l) => l.includes('stopped (aborted)'))).toBe(true);
        expect(logs[0]).toContain('stop with SIGTERM');
        expect(logs[logs.length - 1]).toContain('stopped — 2 account(s), 4 message(s) received');
      } finally {
        controller.abort();
      }
    });

    await it('reports a logged-out account once, and does not reconnect it', async () => {
      const controller = new AbortController();
      const logs: string[] = [];
      const backend = new ScriptedBackend(['a-1']);
      let rebuilds = 0;
      try {
        const running = runDeliveryDaemon({
          dbPath: ':memory:',
          backends: [backend],
          signal: controller.signal,
          rebuildDebounceMs: 5,
          log: (line) => logs.push(line),
          rebuild: async () => {
            rebuilds++;
            return REBUILD;
          },
        });
        await settle();
        backend.sessions.get('a-1')?.end({ caughtUp: false, error: 'logged out', loggedOut: true });
        const result = await running;
        expect(result.accounts[0].loggedOut).toBe(true);
        expect(result.errors).toBe(1);
        // The one account ended, so the whole run is over — and nothing was written, so no
        // rebuild was needed.
        expect(rebuilds).toBe(0);
        expect(logs.filter((l) => l.includes('logged out')).length).toBe(1);
        expect(logs.some((l) => l.includes('reconnect in'))).toBe(false);
      } finally {
        controller.abort();
      }
    });

    await it('waits for an account another holder has, and says who holds it', async () => {
      const controller = new AbortController();
      const logs: string[] = [];
      const backend = new ScriptedBackend(['a-1']);
      // A file index, so the lease of a daemon in another session can be planted first.
      const dir = mkdtempSync(join(tmpdir(), 'curlew-daemon-'));
      const dbPath = join(dir, 'index.db');
      const seed = openIndex(dbPath);
      try {
        takeReceiveLease(seed, BACKEND, 'a-1', 'pid-other-daemon', new Date());
        seed.close();
        const running = runDeliveryDaemon({
          dbPath,
          backends: [backend],
          signal: controller.signal,
          rebuildDebounceMs: 5,
          log: (line) => logs.push(line),
          rebuild: async () => REBUILD,
        });
        await settle();
        // Nothing was connected: that account is the other daemon's. A daemon does NOT give it
        // up for good — it waits, and says whom it waits for.
        expect(backend.sessions.size).toBe(0);
        expect(logs.some((l) => l.includes('held by pid-other-daemon — waiting for the lease'))).toBe(true);
        controller.abort();
        const result = await running;
        expect(result.accounts[0].heldBy).toBe(null);
        expect(result.errors).toBe(0);
      } finally {
        controller.abort();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('refuses to start with nothing to receive', async () => {
      let message: string | null = null;
      try {
        await runDeliveryDaemon({ dbPath: ':memory:', backends: [], log: () => {} });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message ?? '').toMatch(/no delivery-only backend is enabled/);
    });
  });
};
