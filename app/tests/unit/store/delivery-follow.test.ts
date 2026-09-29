import { describe, expect, it } from '@gjsify/unit';

import type {
  BackendAccount,
  BackendManifest,
  ChatMessage,
  ChatPeer,
  DeliveryBackend,
  DeliveryEvent,
  DeliveryOutcome,
  DeliverySession,
} from '@postbote/protocol';
import { PLUGIN_API_VERSION } from '@postbote/protocol';
import type { DeliveryProgress } from '@postbote/store';
import type { IndexDatabase } from '@postbote/store';
import { chatConversationId, getConversation, receiveDeliveries, takeReceiveLease } from '@postbote/store';
import { freshDb } from './fixtures.ts';

/**
 * The follow-mode half of the receive engine, without a network: what a daemon needs and what a
 * `sync` never does — several accounts at once, a stop from outside, a reconnect after a dropped
 * socket, and a device that is gone for good. All data is synthetic.
 *
 * Time is injected, so a backoff that waits 5 s costs no wall clock here.
 */

const BACKEND = 'fakefollow';

const ANNA: ChatPeer = {
  remoteId: 'anna',
  displayName: 'Anna Example',
  addresses: [{ kind: 'phone', value: '+491510000001' }],
  bot: false,
};

function msg(id: string, seq: number, body: string): ChatMessage {
  return {
    remoteId: id,
    seq,
    sentAt: new Date(Date.UTC(2026, 0, 1, 12, 0, seq)).toISOString(),
    editedAt: null,
    sender: ANNA,
    fromSelf: false,
    text: body,
    hasAttachments: false,
    replyToRemoteId: null,
    threadRemoteId: null,
  };
}

const incoming = (chat: string, m: ChatMessage): DeliveryEvent => ({
  type: 'message',
  chatRemoteId: chat,
  chatKind: 'direct',
  message: m,
  seen: false,
});

/** A session the test drives: batches go in, the outcome and the end are the test's to decide. */
class ControllableSession implements DeliverySession {
  closeCalls = 0;
  private queue: DeliveryEvent[] = [];
  private waiters: Array<() => void> = [];
  private ended = false;
  private result: DeliveryOutcome = { caughtUp: false, error: null };

  /** Queue events the next `nextBatch()` hands out. */
  push(...events: DeliveryEvent[]): void {
    this.queue.push(...events);
    this.wake();
  }

  /** End the session the way the network would: `nextBatch()` resolves null. */
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
    // Idempotent, like both receivers: the store closes on abort and again in its finally.
    if (this.closeCalls > 0) return;
    this.closeCalls++;
    this.ended = true;
    this.wake();
  }
}

/** One delivery backend with the accounts and the sessions the test scripts. */
class FollowBackend implements DeliveryBackend {
  readonly manifest: BackendManifest = {
    name: BACKEND,
    displayName: 'Fake follow',
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
  /** One per connect, in order. */
  readonly sessions: ControllableSession[] = [];
  readonly connects: string[] = [];

  constructor(private readonly accountIds: string[]) {}

  async listAccounts(): Promise<BackendAccount[]> {
    return this.accountIds.map((id) => ({ id, identity: id, provider: 'Fake' }));
  }

  async connect(accountId: string): Promise<DeliverySession> {
    this.connects.push(accountId);
    const session = new ControllableSession();
    this.sessions.push(session);
    return session;
  }

  /** The session an account is holding open right now — its most recent connect. */
  sessionOf(accountId: string): ControllableSession | null {
    for (let i = this.connects.length - 1; i >= 0; i--) {
      if (this.connects[i] === accountId) return this.sessions[i];
    }
    return null;
  }
}

/** The lease row's holder, read straight from the table. */
function leaseHolder(db: IndexDatabase, accountId: string): string | null {
  const row = db
    .prepare('SELECT holder FROM receive_leases WHERE backend = ? AND account_id = ?')
    .get(BACKEND, accountId) as { holder?: unknown } | undefined;
  return row ? String(row.holder) : null;
}

/** Poll until `done` — the lease retry runs on a timer, not on a promise the test holds. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (done()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 4));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

/** Two ticks: one for the reconnect, one for the new connect to have happened. */
const settle = async () => {
  await tick();
  await tick();
};

export default async () => {
  await describe('receiveDeliveries in follow mode', async () => {
    await it('receives two accounts at once, and an abort closes both', async () => {
      const db = freshDb();
      const controller = new AbortController();
      const progress: DeliveryProgress[] = [];
      try {
        const backend = new FollowBackend(['a-1', 'a-2']);
        const received = receiveDeliveries(db, backend, {
          mode: 'follow',
          signal: controller.signal,
          onProgress: (event) => progress.push(event),
        });
        await settle();
        // Concurrent: the second account is already connected while the first is still open.
        expect(backend.connects.join(',')).toBe('a-1,a-2');
        backend.sessionOf('a-1')?.push(incoming('d-anna', msg('a1/1', 1, 'eins')));
        backend.sessionOf('a-2')?.push(incoming('d-anna', msg('a2/1', 1, 'zwei')));
        await settle();
        // The stop from outside: a stopped daemon is a successful run, not an error.
        controller.abort();
        const result = await received;
        expect(result.added).toBe(2);
        expect(result.errors).toBe(0);
        expect(result.failed).toBe(false);
        expect(result.accounts.length).toBe(2);
        expect(backend.sessions.every((s) => s.closeCalls === 1)).toBe(true);
        for (const account of ['a-1', 'a-2']) {
          const id = chatConversationId(BACKEND, account, 'd-anna');
          expect(getConversation(db, id)?.messages.length).toBe(1);
        }
        expect(
          progress
            .filter((p) => p.type === 'connected')
            .map((p) => `${p.backend}/${p.accountId}`)
            .join(','),
        ).toBe(`${BACKEND}/a-1,${BACKEND}/a-2`);
        expect(progress.filter((p) => p.type === 'stopped').length).toBe(2);
      } finally {
        controller.abort();
        db.close();
      }
    });

    await it('keeps catch-up sequential — a sync reports per account', async () => {
      const db = freshDb();
      try {
        const backend = new FollowBackend(['a-1', 'a-2']);
        const received = receiveDeliveries(db, backend);
        await tick();
        // The first account's session is still open, so the second one has not been reached.
        expect(backend.connects.join(',')).toBe('a-1');
        backend.sessionOf('a-1')?.end({ caughtUp: true, error: null });
        await settle();
        expect(backend.connects.join(',')).toBe('a-1,a-2');
        backend.sessionOf('a-2')?.end({ caughtUp: true, error: null });
        const result = await received;
        expect(result.accounts.length).toBe(2);
        expect(result.errors).toBe(0);
        await received;
      } finally {
        db.close();
      }
    });

    await it('reconnects a session that ended in an error, doubling the wait', async () => {
      const db = freshDb();
      const controller = new AbortController();
      const progress: DeliveryProgress[] = [];
      const waited: number[] = [];
      try {
        const backend = new FollowBackend(['a-1']);
        const received = receiveDeliveries(db, backend, {
          mode: 'follow',
          signal: controller.signal,
          sleep: (ms) => {
            waited.push(ms);
            return Promise.resolve();
          },
          onProgress: (event) => progress.push(event),
        });
        await settle();
        backend.sessionOf('a-1')?.end({ caughtUp: false, error: 'the connection closed' });
        await settle();
        backend.sessionOf('a-1')?.end({ caughtUp: false, error: 'the connection closed' });
        await settle();
        // A follow session that ends on its own is a reconnect, not a stop: only the signal
        // (or a device the network dropped) ends the account.
        controller.abort();
        const result = await received;
        expect(result.errors).toBe(0);
        expect(backend.connects.length).toBe(3);
        expect(waited.join(',')).toBe('5000,10000');
        expect(
          progress
            .filter((p) => p.type === 'reconnect')
            .map((p) => (p.type === 'reconnect' ? p.delayMs : 0))
            .join(','),
        ).toBe('5000,10000');
        expect(progress.filter((p) => p.type === 'batch').length).toBe(0);
      } finally {
        controller.abort();
        db.close();
      }
    });

    await it('caps the wait, and resets it after a session that lived past the cap', async () => {
      const db = freshDb();
      const controller = new AbortController();
      const waited: number[] = [];
      let clock = 0;
      try {
        const backend = new FollowBackend(['a-1']);
        const received = receiveDeliveries(db, backend, {
          mode: 'follow',
          signal: controller.signal,
          now: () => new Date(clock),
          sleep: (ms) => {
            waited.push(ms);
            return Promise.resolve();
          },
        });
        await settle();
        for (const _step of [0, 0, 0, 0, 0, 0, 0]) {
          backend.sessionOf('a-1')?.end({ caughtUp: false, error: 'the connection closed' });
          await settle();
        }
        // This one stays connected longer than the cap: the network is up, so the wait starts over.
        clock += 6 * 60_000;
        backend.sessionOf('a-1')?.end({ caughtUp: false, error: 'the connection closed' });
        await settle();
        controller.abort();
        await received;
        expect(waited.join(',')).toBe('5000,10000,20000,40000,80000,160000,300000,5000');
      } finally {
        controller.abort();
        db.close();
      }
    });

    await it('does not retry a device the network no longer knows', async () => {
      const db = freshDb();
      const controller = new AbortController();
      const progress: DeliveryProgress[] = [];
      const waited: number[] = [];
      try {
        const backend = new FollowBackend(['a-1']);
        const received = receiveDeliveries(db, backend, {
          mode: 'follow',
          signal: controller.signal,
          sleep: (ms) => {
            waited.push(ms);
            return Promise.resolve();
          },
          onProgress: (event) => progress.push(event),
        });
        await settle();
        backend.sessionOf('a-1')?.end({ caughtUp: false, error: 'logged out', loggedOut: true });
        const result = await received;
        expect(backend.connects.length).toBe(1);
        expect(waited.length).toBe(0);
        expect(result.accounts[0].loggedOut).toBe(true);
        expect(progress.filter((p) => p.type === 'logged-out').length).toBe(1);
        expect(progress.filter((p) => p.type === 'reconnect').length).toBe(0);
      } finally {
        controller.abort();
        db.close();
      }
    });
  });

  await describe('the lease between a daemon and a sync', async () => {
    await it('a follow run holds the lease, heartbeats it, and drops it on stop', async () => {
      const db = freshDb();
      const controller = new AbortController();
      try {
        const backend = new FollowBackend(['a-1']);
        const received = receiveDeliveries(db, backend, {
          mode: 'follow',
          signal: controller.signal,
          holder: 'pid-daemon',
          leaseIntervalMs: 5,
        });
        await settle();
        expect(leaseHolder(db, 'a-1')).toBe('pid-daemon');
        const first = db
          .prepare('SELECT heartbeat_at FROM receive_leases WHERE backend = ? AND account_id = ?')
          .get(BACKEND, 'a-1') as { heartbeat_at: string };
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        const second = db
          .prepare('SELECT heartbeat_at FROM receive_leases WHERE backend = ? AND account_id = ?')
          .get(BACKEND, 'a-1') as { heartbeat_at: string };
        // The heartbeat keeps the lease alive, and a run that never refreshes would not.
        expect(second.heartbeat_at > first.heartbeat_at).toBe(true);
        controller.abort();
        await received;
        // Stopped: nothing is held any more, so the next `sync` receives this account.
        expect(leaseHolder(db, 'a-1')).toBe(null);
      } finally {
        controller.abort();
        db.close();
      }
    });

    await it('a daemon waits for a lease another daemon holds, then receives it', async () => {
      const db = freshDb();
      const first = new AbortController();
      const second = new AbortController();
      const progress: DeliveryProgress[] = [];
      try {
        const backend = new FollowBackend(['a-1']);
        const running = receiveDeliveries(db, backend, {
          mode: 'follow',
          signal: first.signal,
          holder: 'pid-1',
        });
        await settle();
        const other = receiveDeliveries(db, backend, {
          mode: 'follow',
          signal: second.signal,
          holder: 'pid-2',
          leaseIntervalMs: 5,
          onProgress: (event) => progress.push(event),
        });
        await settle();
        // The second daemon must NOT give the account up: it waits, and says who it waits for.
        expect(progress.filter((p) => p.type === 'lease-waiting').length).toBe(1);
        expect(backend.connects.length).toBe(1);
        // When the first one stops, the second takes the lease and connects.
        first.abort();
        await running;
        await until(() => backend.connects.length === 2, 'the waiting daemon to take the lease');
        expect(backend.connects.join(',')).toBe('a-1,a-1');
        backend.sessionOf('a-1')?.push(incoming('d-anna', msg('a2/1', 1, 'zwei')));
        await settle();
        second.abort();
        const waited = await other;
        expect(waited.added).toBe(1);
        expect(waited.accounts[0].heldBy).toBeUndefined();
        expect(waited.errors).toBe(0);
      } finally {
        first.abort();
        second.abort();
        db.close();
      }
    });

    await it('a sync that holds the lease keeps a starting daemon off the account', async () => {
      const db = freshDb();
      const sync = new AbortController();
      const daemon = new AbortController();
      const progress: DeliveryProgress[] = [];
      try {
        // A catch-up run that is mid-account: it holds the lease, and a daemon may not join it.
        const syncBackend = new FollowBackend(['a-1']);
        const syncing = receiveDeliveries(db, syncBackend, {
          holder: 'pid-sync',
          signal: sync.signal,
          leaseIntervalMs: 5,
        });
        await settle();
        expect(leaseHolder(db, 'a-1')).toBe('pid-sync');
        const daemonBackend = new FollowBackend(['a-1']);
        const following = receiveDeliveries(db, daemonBackend, {
          mode: 'follow',
          signal: daemon.signal,
          holder: 'pid-daemon',
          leaseIntervalMs: 5,
          onProgress: (event) => progress.push(event),
        });
        await settle();
        expect(daemonBackend.connects.length).toBe(0);
        expect(progress.filter((p) => p.type === 'lease-waiting').length).toBe(1);
        // The sync finishes and drops the lease — the daemon then takes over and receives.
        syncBackend.sessionOf('a-1')?.push(incoming('d-anna', msg('s1/1', 1, 'eins')));
        await settle();
        syncBackend.sessionOf('a-1')?.end({ caughtUp: true, error: null });
        const synced = await syncing;
        expect(synced.added).toBe(1);
        await until(() => daemonBackend.connects.length === 1, 'the daemon to take the lease');
        expect(daemonBackend.connects.join(',')).toBe('a-1');
        daemonBackend.sessionOf('a-1')?.push(incoming('d-anna', msg('d1/1', 1, 'zwei')));
        await settle();
        daemon.abort();
        const followed = await following;
        expect(followed.added).toBe(1);
        expect(followed.errors).toBe(0);
      } finally {
        sync.abort();
        daemon.abort();
        db.close();
      }
    });

    await it('a sync skips the account a daemon holds, and says so without failing', async () => {
      const db = freshDb();
      try {
        takeReceiveLease(db, BACKEND, 'a-1', 'pid-daemon', new Date());
        const backend = new FollowBackend(['a-1', 'a-2']);
        const received = receiveDeliveries(db, backend, { holder: 'pid-sync' });
        await settle();
        // The held account is left alone; the other one is received.
        expect(backend.connects.join(',')).toBe('a-2');
        backend.sessionOf('a-2')?.push(incoming('d-anna', msg('a2/1', 1, 'zwei')));
        await settle();
        backend.sessionOf('a-2')?.end({ caughtUp: true, error: null });
        const result = await received;
        expect(result.added).toBe(1);
        expect(result.accounts.map((a) => `${a.accountId}:${a.heldBy ?? 'received'}`).join(',')).toBe(
          'a-1:pid-daemon,a-2:received',
        );
        expect(result.errors).toBe(0);
        expect(result.failed).toBe(false);
        // The lease is left exactly as it was found.
        expect(leaseHolder(db, 'a-1')).toBe('pid-daemon');
      } finally {
        db.close();
      }
    });

    await it('a sync takes over a lease whose holder died', async () => {
      const db = freshDb();
      try {
        takeReceiveLease(db, BACKEND, 'a-1', 'pid-dead', new Date(Date.now() - 10 * 60_000));
        const backend = new FollowBackend(['a-1']);
        const received = receiveDeliveries(db, backend);
        await settle();
        expect(backend.connects.join(',')).toBe('a-1');
        backend.sessionOf('a-1')?.end({ caughtUp: true, error: null });
        const result = await received;
        expect(result.accounts[0].heldBy).toBeUndefined();
        expect(result.errors).toBe(0);
      } finally {
        db.close();
      }
    });
  });
};
