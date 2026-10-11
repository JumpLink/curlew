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

function fakeLink(): XmppLink {
  return {
    jid: 'bot@example.org',
    roster: async () => [],
    bookmarks: async () => [],
    features: async () => new Set(),
    mam: async () => ({ entries: [], complete: true }),
    close: async () => {},
    sendChat: async () => {},
    goAvailable: async () => {},
    onArrival: () => () => {},
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

export default async () => {
  await describe('followAccount lease loss', async () => {
    await it('waits to take the lease again and reconnects instead of ending', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-follow-'));
      const db = freshDb();
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
        expect(opened).toBe(1);

        // Another process takes the account over: the next heartbeat finds the lease gone.
        db.prepare("UPDATE receive_leases SET holder = 'pid-other' WHERE account_id = ?").run(ACCOUNT);
        await until(() => logs.some((l) => l.includes('lost the receive lease')));
        expect(logs.some((l) => l.includes('lost the receive lease'))).toBe(true);

        // It is released again: the account must come back, not stay stopped.
        db.prepare('DELETE FROM receive_leases WHERE account_id = ?').run(ACCOUNT);
        await until(() => opened === 2);
        expect(opened).toBe(2);

        controller.abort();
        const result = await running;
        expect(result.error).toBe(null);
      } finally {
        controller.abort();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
