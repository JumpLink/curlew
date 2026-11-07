import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountPrompter, BackendContext, ByteSink } from '@curlew/protocol';
import { isAttachmentFetcherBackend } from '@curlew/protocol';
import {
  attachmentHandle,
  parseAttachmentHandle,
  TELEGRAM_MANIFEST,
  TelegramBackend,
  toChatMessage,
} from '@curlew/telegram';

import { fakeFactory, tgMessage, user } from './fake-client.ts';

// Synthetic only: a fake client, a temporary directory per case, no session of anyone's.
const ACCOUNT = 'telegram-42';
const ANNA = user(1001, 'Anna Example');

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

class MemorySink implements ByteSink {
  readonly chunks: Uint8Array[] = [];
  closed = false;
  write(chunk: Uint8Array): void {
    this.chunks.push(chunk);
  }
  close(): void {
    this.closed = true;
  }
  get size(): number {
    return this.chunks.reduce((n, c) => n + c.byteLength, 0);
  }
}

function prompter(): AccountPrompter {
  const queue = ['+49 170 0000000', '12345', 'correct horse'];
  return { ask: async () => queue.shift() ?? '', notify: () => {} };
}

const MEDIA = {
  doc: tgMessage(ANNA, 10, ANNA, '', {
    media: { type: 'document', fileName: 'report.pdf', mimeType: 'application/pdf', fileSize: 5 },
  }),
  photo: tgMessage(ANNA, 11, ANNA, '', { media: { type: 'photo', width: 800, height: 600, fileSize: 3 } }),
  voice: tgMessage(ANNA, 12, ANNA, '', {
    media: { type: 'voice', mimeType: 'audio/ogg', duration: 7, fileSize: 2 },
  }),
  video: tgMessage(ANNA, 13, ANNA, '', {
    media: { type: 'video', mimeType: 'video/mp4', width: 640, height: 360, duration: 12, fileSize: 1 },
  }),
  sticker: tgMessage(ANNA, 14, ANNA, '', {
    media: { type: 'sticker', mimeType: 'application/x-tgsticker', fileSize: 1 },
  }),
  paid: tgMessage(ANNA, 15, ANNA, '', { media: { type: 'paid' } }),
};

async function withBackend<T>(
  mediaBytes: Map<string, Uint8Array[]>,
  body: (backend: TelegramBackend, fake: ReturnType<typeof fakeFactory>) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-telegram-attach-'));
  try {
    writeFileSync(join(dir, 'config.json'), '{}');
    const context: BackendContext = {
      settings: {},
      env: { CURLEW_TELEGRAM_API_ID: '12345', CURLEW_TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef' },
      secretsDir: join(dir, 'secrets', 'telegram'),
    };
    const fake = fakeFactory({
      dialogs: [],
      history: new Map([[1001, Object.values(MEDIA)]]),
      mediaBytes,
    });
    const backend = new TelegramBackend(context, fake.create);
    await backend.addAccount(prompter());
    fake.clients.length = 0;
    return await body(backend, fake);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export default async () => {
  await describe('Telegram attachments', async () => {
    await it('claims reading but not sending in its manifest', async () => {
      expect(TELEGRAM_MANIFEST.capabilities.attachmentsRead).toBe(true);
      expect(TELEGRAM_MANIFEST.capabilities.attachments).toBe(false);
    });

    await it('maps each kind of media to one attachment with its facts and a handle', async () => {
      const doc = toChatMessage(MEDIA.doc)?.attachments?.[0];
      expect(doc?.filename).toBe('report.pdf');
      expect(doc?.mimeType).toBe('application/pdf');
      expect(doc?.kind).toBe('file');
      expect(doc?.size).toBe(5);
      expect(doc?.handle).toBe(attachmentHandle(1001, 10));

      const photo = toChatMessage(MEDIA.photo)?.attachments?.[0];
      expect(photo?.kind).toBe('image');
      expect(photo?.mimeType).toBe('image/jpeg');
      expect(photo?.width).toBe(800);
      expect(photo?.height).toBe(600);
      expect(photo?.filename).toBe(null);

      const voice = toChatMessage(MEDIA.voice)?.attachments?.[0];
      expect(voice?.kind).toBe('voice');
      expect(voice?.durationMs).toBe(7000);

      const video = toChatMessage(MEDIA.video)?.attachments?.[0];
      expect(video?.kind).toBe('video');
      expect(video?.durationMs).toBe(12000);

      // An animated sticker is not a picture the window can show: it stays a file.
      expect(toChatMessage(MEDIA.sticker)?.attachments?.[0]?.kind).toBe('file');
      // Paid media is locked: flagged, but there is nothing to fetch.
      const paid = toChatMessage(MEDIA.paid);
      expect(paid?.hasAttachments).toBe(true);
      expect(paid?.attachments === undefined).toBe(true);
    });

    await it('reads back only the handles it wrote', async () => {
      expect(parseAttachmentHandle(attachmentHandle(-1004001, 20))).toStrictEqual({
        chatId: -1004001,
        messageId: 20,
      });
      for (const bad of ['', 'nope', '[]', 'null', '{"chatId":"1","messageId":2}', '{"chatId":1}']) {
        expect(parseAttachmentHandle(bad)).toBe(null);
      }
    });

    await it('streams the file into the sink and closes the session', async () => {
      const media = new Map([['1001/10', [bytes(1, 2, 3), bytes(4, 5)]]]);
      await withBackend(media, async (backend, fake) => {
        expect(isAttachmentFetcherBackend(backend)).toBe(true);
        const fetcher = await backend.openAttachments(ACCOUNT);
        const sink = new MemorySink();
        const result = await fetcher.fetchAttachment(
          { backend: 'telegram', accountId: ACCOUNT },
          { kind: 'file', handle: attachmentHandle(1001, 10) },
          sink,
          { maxBytes: 1000 },
        );
        expect(result.size).toBe(5);
        expect(result.mimeType).toBe('application/pdf');
        expect(sink.size).toBe(5);
        expect(fake.clients[0].destroyed).toBe(1);
        expect(fake.clients[0].calls.includes('openMedia:1001/10')).toBe(true);
      });
    });

    await it('fetches a photo although its announced size is the largest encoding', async () => {
      const media = new Map([['1001/11', [bytes(9, 9)]]]);
      await withBackend(media, async (backend) => {
        const fetcher = await backend.openAttachments(ACCOUNT);
        const sink = new MemorySink();
        const result = await fetcher.fetchAttachment(
          { backend: 'telegram', accountId: ACCOUNT },
          { kind: 'image', handle: attachmentHandle(1001, 11) },
          sink,
          { maxBytes: 1000 },
        );
        expect(result.size).toBe(2);
        expect(result.mimeType).toBe('image/jpeg');
      });
    });

    await it('refuses a file over the limit before downloading, and one that outgrows it', async () => {
      const media = new Map([
        ['1001/10', [bytes(1, 2, 3, 4, 5)]],
        ['1001/12', [bytes(1, 2, 3, 4, 5, 6)]],
      ]);
      await withBackend(media, async (backend) => {
        const open = async () => backend.openAttachments(ACCOUNT);
        const announced = await failure(
          (await open()).fetchAttachment(
            { backend: 'telegram', accountId: ACCOUNT },
            { kind: 'file', handle: attachmentHandle(1001, 10) },
            new MemorySink(),
            { maxBytes: 4 },
          ),
        );
        expect(announced).not.toBe(null);
        const sink = new MemorySink();
        // The voice note announced 2 bytes but streams 6: the limit stops it, not the announcement.
        const outgrown = await failure(
          (await open()).fetchAttachment(
            { backend: 'telegram', accountId: ACCOUNT },
            { kind: 'voice', handle: attachmentHandle(1001, 12) },
            sink,
            { maxBytes: 4 },
          ),
        );
        expect(outgrown).not.toBe(null);
      });
    });

    await it('throws when the bytes do not match the announced size', async () => {
      const media = new Map([['1001/10', [bytes(1, 2, 3)]]]);
      await withBackend(media, async (backend) => {
        const message = await failure(
          (await backend.openAttachments(ACCOUNT)).fetchAttachment(
            { backend: 'telegram', accountId: ACCOUNT },
            { kind: 'file', handle: attachmentHandle(1001, 10) },
            new MemorySink(),
            { maxBytes: 1000 },
          ),
        );
        expect(message).not.toBe(null);
      });
    });

    await it('says so when the message or its file is gone, and never reads a foreign handle', async () => {
      await withBackend(new Map(), async (backend, fake) => {
        for (const handle of [attachmentHandle(1001, 10), attachmentHandle(1001, 99), 'not a handle']) {
          const message = await failure(
            (await backend.openAttachments(ACCOUNT)).fetchAttachment(
              { backend: 'telegram', accountId: ACCOUNT },
              { kind: 'file', handle },
              new MemorySink(),
              { maxBytes: 1000 },
            ),
          );
          expect(message).not.toBe(null);
        }
        // Every attempt closed its session, the failed ones included.
        expect(fake.clients.every((c) => c.destroyed === 1)).toBe(true);
      });
    });
  });
};
