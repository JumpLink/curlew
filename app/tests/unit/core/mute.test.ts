import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MessageBackend, MessageSender, SendingChatFlags } from '@curlew/protocol';
import { chatConversationId, loadChatFlags, rebuildConversations, syncChats } from '@curlew/store';
import { openIndex } from '../../../src/core/actions/index-sync.ts';
import { setConversationMute } from '../../../src/core/actions/mute.ts';
import { telegramFixture } from '../store/chat-fixtures.ts';

// Synthetic only: a fake sender, a temporary index and config, nothing on any network.

const ACCOUNT = 'telegram-42';
const CHAT = '1001';
const DIRECT = chatConversationId('telegram', ACCOUNT, CHAT);

function fakeBackend(requests: SendingChatFlags[], fail = false): MessageBackend {
  const sender = {
    features: { chatFlags: true },
    setChatFlags: async (r: SendingChatFlags) => {
      if (fail) throw new Error('offline');
      requests.push(r);
    },
    close: async () => {},
  } as unknown as MessageSender;
  return {
    manifest: { name: 'telegram', sendSharesReceiveState: false, capabilities: { mutes: true } },
    listAccounts: async () => [{ id: ACCOUNT, identity: ACCOUNT, provider: 'telegram' }],
    openSender: async () => sender,
  } as unknown as MessageBackend;
}

async function withRig(
  ui: Record<string, unknown>,
  body: (rig: { db: ReturnType<typeof openIndex>; base: Record<string, unknown> }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-mute-'));
  const dbPath = join(dir, 'index.db');
  const db = openIndex(dbPath);
  try {
    await syncChats(db, telegramFixture());
    rebuildConversations(db);
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ ui }));
    await body({
      db,
      base: { dbPath, configPath, writeLogPath: join(dir, 'writes.log') },
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async () => {
  await describe('setConversationMute', async () => {
    await it('mutes locally, pushes, and clears the pending mark', async () => {
      await withRig({}, async ({ db, base }) => {
        const requests: SendingChatFlags[] = [];
        const outcome = await setConversationMute({
          ...base,
          db,
          conversationId: DIRECT,
          accountId: ACCOUNT,
          to: CHAT,
          mute: { muted: true, until: null },
          frontend: 'window',
          backend: fakeBackend(requests),
        });
        expect(outcome).toBe('pushed');
        expect(requests.length).toBe(1);
        const flags = loadChatFlags(db, DIRECT);
        expect(flags?.muted).toBe(true);
        expect(flags?.mutePendingAt).toBe(null);
      });
    });

    await it('keeps the mark pending when the push fails, and the flag local', async () => {
      await withRig({}, async ({ db, base }) => {
        const outcome = await setConversationMute({
          ...base,
          db,
          conversationId: DIRECT,
          accountId: ACCOUNT,
          to: CHAT,
          mute: { muted: true, until: null },
          frontend: 'window',
          backend: fakeBackend([], true),
        });
        expect(outcome).toBe('failed');
        const flags = loadChatFlags(db, DIRECT);
        expect(flags?.muted).toBe(true);
        expect(flags?.mutePendingAt === null).toBe(false);
      });
    });

    await it('pushes nothing and marks nothing while ui.syncChatFlags is off', async () => {
      await withRig({ syncChatFlags: false }, async ({ db, base }) => {
        const requests: SendingChatFlags[] = [];
        const outcome = await setConversationMute({
          ...base,
          db,
          conversationId: DIRECT,
          accountId: ACCOUNT,
          to: CHAT,
          mute: { muted: true, until: '2099-01-01T00:00:00.000Z' },
          frontend: 'window',
          backend: fakeBackend(requests),
        });
        expect(outcome).toBe('off');
        expect(requests.length).toBe(0);
        const flags = loadChatFlags(db, DIRECT);
        expect(flags?.muted).toBe(true);
        expect(flags?.mutedUntil).toBe('2099-01-01T00:00:00.000Z');
        expect(flags?.mutePendingAt).toBe(null);
      });
    });
  });
};
