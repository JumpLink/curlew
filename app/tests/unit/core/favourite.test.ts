import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ChatPinLimitError,
  type MessageBackend,
  type MessageSender,
  type SendingChatFlags,
} from '@curlew/protocol';
import { asChatPinLimit } from '@curlew/protocol';
import {
  applyRemoteFavourite,
  chatConversationId,
  loadChatFlags,
  rebuildConversations,
  syncChats,
} from '@curlew/store';
import { openIndex } from '../../../src/core/actions/index-sync.ts';
import { setConversationFavourite } from '../../../src/core/actions/favourite.ts';
import { telegramFixture } from '../store/chat-fixtures.ts';

// Synthetic only: a fake sender, a temporary index and config, nothing on any network.

const ACCOUNT = 'telegram-42';
const CHAT = '1001';
const DIRECT = chatConversationId('telegram', ACCOUNT, CHAT);

function fakeBackend(requests: SendingChatFlags[], fail: Error | null = null): MessageBackend {
  const sender = {
    features: { chatFlags: true },
    setChatFlags: async (r: SendingChatFlags) => {
      if (fail) throw fail;
      requests.push(r);
    },
    close: async () => {},
  } as unknown as MessageSender;
  return {
    manifest: { name: 'telegram', sendSharesReceiveState: false, capabilities: { mutes: true, pins: true } },
    listAccounts: async () => [{ id: ACCOUNT, identity: ACCOUNT, provider: 'telegram' }],
    openSender: async () => sender,
  } as unknown as MessageBackend;
}

async function withRig(
  ui: Record<string, unknown>,
  body: (rig: { db: ReturnType<typeof openIndex>; base: Record<string, unknown> }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-fav-'));
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
  await describe('setConversationFavourite', async () => {
    const star = (
      rig: { db: ReturnType<typeof openIndex>; base: Record<string, unknown> },
      backend: MessageBackend,
      favourite = true,
    ) =>
      setConversationFavourite({
        ...rig.base,
        db: rig.db,
        conversationId: DIRECT,
        accountId: ACCOUNT,
        to: CHAT,
        favourite,
        frontend: 'window',
        backend,
      });

    await it('stars locally, pushes, and clears the pending mark', async () => {
      await withRig({}, async (rig) => {
        const requests: SendingChatFlags[] = [];
        expect((await star(rig, fakeBackend(requests))).kind).toBe('pushed');
        expect(requests.length).toBe(1);
        expect(requests[0].favourite).toBe(true);
        expect(requests[0].mute === undefined).toBe(true);
        const flags = loadChatFlags(rig.db, DIRECT);
        expect(flags?.favourite).toBe(true);
        expect(flags?.favouritePendingAt).toBe(null);
      });
    });

    await it('keeps the mark pending when the push fails, and the star local', async () => {
      await withRig({}, async (rig) => {
        expect((await star(rig, fakeBackend([], new Error('offline')))).kind).toBe('failed');
        const flags = loadChatFlags(rig.db, DIRECT);
        expect(flags?.favourite).toBe(true);
        expect(flags?.favouritePendingAt === null).toBe(false);
      });
    });

    await it('keeps a star beyond the pin limit local, tells so, and a sync does not take it back', async () => {
      await withRig({}, async (rig) => {
        const outcome = await star(rig, fakeBackend([], new ChatPinLimitError(3)));
        expect(outcome.kind).toBe('full');
        expect(outcome.kind === 'full' ? outcome.limit : -1).toBe(3);
        const flags = loadChatFlags(rig.db, DIRECT);
        expect(flags?.favourite).toBe(true);
        expect(flags?.favouritePendingAt).toBe(null);
        applyRemoteFavourite(rig.db, DIRECT, false, { apply: true });
        expect(loadChatFlags(rig.db, DIRECT)?.favourite).toBe(true);
        applyRemoteFavourite(rig.db, DIRECT, true, { apply: true });
        applyRemoteFavourite(rig.db, DIRECT, false, { apply: true });
        expect(loadChatFlags(rig.db, DIRECT)?.favourite).toBe(false);
      });
    });

    await it('knows the pin limit again after the daemon turned it into text', async () => {
      expect(asChatPinLimit(new Error(new ChatPinLimitError(5).message))?.limit).toBe(5);
      expect(asChatPinLimit(new Error('offline')) === null).toBe(true);
    });

    await it('pushes nothing and marks nothing while ui.syncChatFlags is off', async () => {
      await withRig({ syncChatFlags: false }, async (rig) => {
        const requests: SendingChatFlags[] = [];
        expect((await star(rig, fakeBackend(requests))).kind).toBe('off');
        expect(requests.length).toBe(0);
        const flags = loadChatFlags(rig.db, DIRECT);
        expect(flags?.favourite).toBe(true);
        expect(flags?.favouritePendingAt).toBe(null);
      });
    });
  });
};
