import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatBackend } from '@curlew/protocol';
import { PLUGIN_API_VERSION } from '@curlew/protocol';
import { GrantedXmppSession } from '@curlew/xmpp';
import type { XmppLink } from '@curlew/xmpp';

import { followAccount } from '../../../src/core/actions/follow.ts';
import { freshDb } from '../store/fixtures.ts';

const ACCOUNT = 'xmpp-lease1';
const GRANT = { account: ACCOUNT, addresses: ['owner@example.org'] };

function fakeLink(onClose: () => void = () => {}, onArrival?: (fire: () => void) => void): XmppLink {
  return {
    jid: 'bot@example.org',
    roster: async () => [],
    bookmarks: async () => [],
    features: async () => new Set(),
    mam: async () => ({ entries: [], complete: true }),
    close: async () => onClose(),
    sendChat: async () => {},
    sendEncrypted: async () => {},
    goAvailable: async () => {},
    pepGet: async () => undefined,
    pepSet: async () => {},
    onArrival: (listener) => {
      onArrival?.(listener);
      return () => {};
    },
    onClosed: () => {},
  };
}

const backend: ChatBackend = {
  manifest: {
    name: 'xmpp',
    displayName: 'Fake XMPP',
    pluginApi: PLUGIN_API_VERSION,
  } as ChatBackend['manifest'],
  kind: 'chat',
  listAccounts: async () => [],
  connect: async () => {
    throw new Error('not used');
  },
};

async function until(done: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

/** The index with `BEGIN IMMEDIATE` failing `busy.left` times — what a busy index looks like. */
function busyable(db: ReturnType<typeof freshDb>, busy: { left: number }) {
  const exec = db.exec.bind(db);
  db.exec = (sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && busy.left > 0) {
      busy.left -= 1;
      throw new Error('database is locked');
    }
    return exec(sql);
  };
  return db;
}

function leaseHolder(db: ReturnType<typeof freshDb>): string | null {
  const row = db.prepare('SELECT holder FROM receive_leases WHERE account_id = ?').get(ACCOUNT) as
    | { holder?: unknown }
    | undefined;
  return row ? String(row.holder) : null;
}

export default async () => {
  await describe('followAccount lease loss', async () => {
    await it('waits to take the lease again and reconnects instead of ending', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-follow-'));
      const db = freshDb();
      const controller = new AbortController();
      const logs: string[] = [];
      const events: string[] = [];
      let opened = 0;
      try {
        const running = followAccount({
          db,
          backend,
          open: async () => {
            opened += 1;
            const n = opened;
            events.push(`open ${n}`);
            return new GrantedXmppSession(
              fakeLink(() => events.push(`close ${n}`)),
              GRANT,
              () => 'oid',
            );
          },
          permit: GRANT,
          signal: controller.signal,
          log: (line) => logs.push(line),
          onWrite: () => {},
          holder: 'pid-me',
          leaseIntervalMs: 30,
          minGapMs: 0,
          writeLogPath: join(dir, 'write.log'),
        });
        await until(() => opened === 1);
        expect(opened).toBe(1);

        // Another process takes the account over: the next heartbeat finds the lease gone.
        db.prepare("UPDATE receive_leases SET holder = 'pid-other' WHERE account_id = ?").run(ACCOUNT);
        await until(() => logs.some((l) => l.includes('lost the receive lease')));
        expect(logs.some((l) => l.includes('lost the receive lease'))).toBe(true);

        // It is released again: the account must come back, not stay stopped.
        db.prepare('DELETE FROM receive_leases WHERE account_id = ?').run(ACCOUNT);
        await until(() => opened === 2);
        expect(opened).toBe(2);
        expect(events.indexOf('close 1')).toBeGreaterThan(-1);
        expect(events.indexOf('close 1')).toBeLessThan(events.indexOf('open 2'));
        expect(leaseHolder(db)).toBe('pid-me');

        controller.abort();
        await running;
      } finally {
        controller.abort();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('rides out one busy tick without reconnecting', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-follow-'));
      const db = freshDb();
      const busy = { left: 0 };
      busyable(db, busy);
      const controller = new AbortController();
      const logs: string[] = [];
      let opened = 0;
      try {
        const running = followAccount({
          db,
          backend,
          open: async () => {
            opened += 1;
            return new GrantedXmppSession(fakeLink(), GRANT, () => 'oid');
          },
          permit: GRANT,
          signal: controller.signal,
          log: (line) => logs.push(line),
          onWrite: () => {},
          holder: 'pid-me',
          leaseIntervalMs: 30,
          minGapMs: 0,
          writeLogPath: join(dir, 'write.log'),
        });
        await until(() => opened === 1);
        busy.left = 1;
        await until(() => busy.left === 0);
        // Several clean ticks after the busy one: the counter is reset and nothing was torn down.
        await new Promise((r) => setTimeout(r, 150));
        expect(busy.left).toBe(0);
        expect(opened).toBe(1);
        expect(logs.some((l) => l.includes('receive lease'))).toBe(false);
        expect(leaseHolder(db)).toBe('pid-me');

        controller.abort();
        await running;
      } finally {
        controller.abort();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await describe('followAccount live path', async () => {
    await it('logs every hint and every catch-up, also one that added nothing', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-follow-'));
      const controller = new AbortController();
      const logs: string[] = [];
      let fire: () => void = () => {};
      try {
        const running = followAccount({
          db: freshDb(),
          backend,
          open: async () =>
            new GrantedXmppSession(
              fakeLink(undefined, (l) => (fire = l)),
              GRANT,
              () => 'oid',
            ),
          permit: GRANT,
          signal: controller.signal,
          log: (line) => logs.push(line),
          onWrite: () => {},
          holder: 'pid-me',
          leaseIntervalMs: 1000,
          minGapMs: 0,
          writeLogPath: join(dir, 'write.log'),
        });
        await until(() => logs.some((l) => l.includes('connected')));
        const before = logs.filter((l) => l.includes('catch-up wrote')).length;
        fire();
        await until(() => logs.filter((l) => l.includes('catch-up wrote')).length > before);
        expect(logs.some((l) => l.includes('arrival hint'))).toBe(true);
        expect(logs.filter((l) => l.includes('catch-up wrote 0 added')).length).toBeGreaterThan(before);
        controller.abort();
        await running;
      } finally {
        controller.abort();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
