import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountPrompter, BackendContext, ByteSink } from '@curlew/protocol';
import { TELEGRAM_MANIFEST, TelegramBackend } from '@curlew/telegram';

import { fakeFactory } from './fake-client.ts';

// Synthetic only: a fake client, a temporary directory per case, no session of anyone's.
const ACCOUNT = 'telegram-42';

class MemorySink implements ByteSink {
  readonly chunks: Uint8Array[] = [];
  write(chunk: Uint8Array): void {
    this.chunks.push(chunk);
  }
  close(): void {}
}

function prompter(): AccountPrompter {
  const queue = ['+49 170 0000000', '12345', 'correct horse'];
  return { ask: async () => queue.shift() ?? '', notify: () => {} };
}

async function withBackend<T>(
  avatarBytes: Map<number, Uint8Array[]>,
  body: (backend: TelegramBackend, fake: ReturnType<typeof fakeFactory>) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-telegram-avatar-'));
  try {
    writeFileSync(join(dir, 'config.json'), '{}');
    const context: BackendContext = {
      settings: {},
      env: { CURLEW_TELEGRAM_API_ID: '12345', CURLEW_TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef' },
      secretsDir: join(dir, 'secrets', 'telegram'),
    };
    const fake = fakeFactory({ dialogs: [], history: new Map(), avatarBytes });
    const backend = new TelegramBackend(context, fake.create);
    await backend.addAccount(prompter());
    fake.clients.length = 0;
    return await body(backend, fake);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const OPTIONS = { maxBytes: 1000 };

export default async () => {
  await describe('Telegram avatars', async () => {
    await it('claims avatars in its manifest', async () => {
      expect(TELEGRAM_MANIFEST.capabilities.avatars).toBe(true);
    });

    await it('streams the picture of a chat and null for one without', async () => {
      await withBackend(new Map([[1001, [new Uint8Array([1, 2]), new Uint8Array([3])]]]), async (backend) => {
        const source = await backend.openAvatars(ACCOUNT);
        const sink = new MemorySink();
        const got = await source.fetchAvatar('1001', sink, OPTIONS);
        expect(got?.size).toBe(3);
        expect(got?.mimeType).toBe('image/jpeg');
        expect(sink.chunks.length).toBe(2);
        expect(await source.fetchAvatar('2002', new MemorySink(), OPTIONS)).toBe(null);
        await source.close();
      });
    });

    await it('serves many chats on one connection and closes it once', async () => {
      await withBackend(new Map([[1, [new Uint8Array([1])]]]), async (backend, fake) => {
        const source = await backend.openAvatars(ACCOUNT);
        await source.fetchAvatar('1', new MemorySink(), OPTIONS);
        await source.fetchAvatar('2', new MemorySink(), OPTIONS);
        await source.close();
        expect(fake.clients.length).toBe(1);
        expect(fake.clients[0]?.destroyed).toBe(1);
      });
    });

    await it('refuses a picture over the limit and a peer that is no chat id', async () => {
      await withBackend(new Map([[1, [new Uint8Array(2000)]]]), async (backend) => {
        const source = await backend.openAvatars(ACCOUNT);
        let message: string | null = null;
        try {
          await source.fetchAvatar('1', new MemorySink(), OPTIONS);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        expect(message?.includes('limit') ?? false).toBe(true);
        expect(await source.fetchAvatar('someone@example.org', new MemorySink(), OPTIONS)).toBe(null);
        await source.close();
      });
    });
  });
};
