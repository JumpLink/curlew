import { describe, expect, it } from '@gjsify/unit';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';

import type { ByteSink } from '@curlew/protocol';
import { isAttachmentFetcherBackend } from '@curlew/protocol';
import {
  attachmentHandle,
  extractAttachments,
  parseAttachmentHandle,
  WHATSAPP_MANIFEST,
  WhatsAppBackend,
  WhatsAppMapper,
} from '@curlew/whatsapp';
import type { WaMedia, WaMediaDownloader, WaMediaSource } from '@curlew/whatsapp';

import { waMessage } from './fake-socket.ts';
import { ACCOUNT, context, link, tempDir } from './world.ts';

// Synthetic only: random-looking bytes, example.invalid pointers, a fake downloader, no network.
const KEY = new Uint8Array(32).fill(7);
const PLAIN = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const sha = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());

const media = (extra: WaMedia = {}): WaMedia => ({
  directPath: '/v/t62.7118-24/synthetic',
  mediaKey: KEY,
  fileSha256: sha(PLAIN),
  fileLength: PLAIN.byteLength,
  mimetype: 'image/jpeg',
  ...extra,
});

class MemorySink implements ByteSink {
  readonly chunks: Uint8Array[] = [];
  write(chunk: Uint8Array): void {
    this.chunks.push(chunk);
  }
  close(): void {}
  get size(): number {
    return this.chunks.reduce((n, c) => n + c.byteLength, 0);
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

/** A downloader that serves `chunks`, or fails with a CDN status; records what it was asked for. */
function fakeDownloader(chunks: Uint8Array[], status?: number) {
  const asked: WaMediaSource[] = [];
  const download: WaMediaDownloader = async (source) => {
    asked.push(source);
    if (status !== undefined) {
      throw Object.assign(new Error('Failed to fetch stream from https://example.invalid/?oh=secret'), {
        output: { statusCode: status },
      });
    }
    return (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
  };
  return { download, asked };
}

const handleOf = (extra: WaMedia = {}, field: 'imageMessage' | 'documentMessage' = 'imageMessage') =>
  extractAttachments({ [field]: media(extra) })[0]!.handle;

async function withBackend<T>(
  downloader: WaMediaDownloader,
  body: (
    fetch: (handle: string, sink: ByteSink, maxBytes?: number) => Promise<{ size: number }>,
  ) => Promise<T>,
): Promise<T> {
  const dir = tempDir();
  try {
    await link(dir);
    const backend = new WhatsAppBackend(context(dir), { createMediaDownloader: () => downloader });
    expect(isAttachmentFetcherBackend(backend)).toBe(true);
    return await body(async (handle, sink, maxBytes = 1000) =>
      (await backend.openAttachments(ACCOUNT)).fetchAttachment(
        { backend: 'whatsapp', accountId: ACCOUNT },
        { kind: 'file', handle },
        sink,
        { maxBytes },
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async () => {
  await describe('WhatsApp attachments', async () => {
    await it('claims reading but not sending in its manifest', async () => {
      expect(WHATSAPP_MANIFEST.capabilities.attachmentsRead).toBe(true);
      expect(WHATSAPP_MANIFEST.capabilities.attachments).toBe(false);
    });

    await it('maps images, videos, voice notes, documents and stickers with their facts', async () => {
      const [image] = extractAttachments({ imageMessage: media({ width: 800, height: 600 }) });
      expect(image?.kind).toBe('image');
      expect(image?.mimeType).toBe('image/jpeg');
      expect(image?.size).toBe(PLAIN.byteLength);
      expect(image?.width).toBe(800);
      expect(image?.height).toBe(600);
      expect(image?.filename).toBe(null);

      const [video] = extractAttachments({ videoMessage: media({ mimetype: 'video/mp4', seconds: 12 }) });
      expect(video?.kind).toBe('video');
      expect(video?.durationMs).toBe(12000);
      expect(extractAttachments({ ptvMessage: media({ mimetype: 'video/mp4' }) })[0]?.kind).toBe('video');

      const voice = extractAttachments({
        audioMessage: media({ mimetype: 'audio/ogg', ptt: true, seconds: 3 }),
      })[0];
      expect(voice?.kind).toBe('voice');
      expect(extractAttachments({ audioMessage: media({ mimetype: 'audio/mpeg' }) })[0]?.kind).toBe('audio');

      const doc = extractAttachments({
        documentMessage: media({ mimetype: 'application/pdf', fileName: 'plan.pdf' }),
      })[0];
      expect(doc?.kind).toBe('file');
      expect(doc?.filename).toBe('plan.pdf');
      expect(extractAttachments({ stickerMessage: media({ mimetype: 'image/webp' }) })[0]?.kind).toBe(
        'image',
      );
    });

    await it('gives a media message without a key or a pointer no row, and a plain text none', async () => {
      expect(extractAttachments({ imageMessage: media({ mediaKey: null }) }).length).toBe(0);
      expect(extractAttachments({ imageMessage: media({ directPath: null, url: null }) }).length).toBe(0);
      expect(
        extractAttachments({ imageMessage: media({ directPath: null, url: 'https://example.invalid/x' }) })
          .length,
      ).toBe(1);
      expect(extractAttachments({ conversation: 'Hallo' }).length).toBe(0);
      expect(extractAttachments(null).length).toBe(0);
    });

    await it('carries the attachments on the mapped message', async () => {
      const [event] = new WhatsAppMapper().message(
        waMessage('100000000000001@lid', 'M1', 1_767_268_800, { imageMessage: media({ caption: 'Foto' }) }),
        false,
      );
      expect(event?.type).toBe('message');
      if (event?.type !== 'message') return;
      expect(event.message.text).toBe('Foto');
      expect(event.message.hasAttachments).toBe(true);
      expect(event.message.attachments?.length).toBe(1);
    });

    await it('reads back only the handles it wrote', async () => {
      const written = parseAttachmentHandle(handleOf());
      expect(written?.type).toBe('image');
      expect(written?.length).toBe(PLAIN.byteLength);
      expect(written?.directPath).toBe('/v/t62.7118-24/synthetic');
      for (const bad of [
        '',
        'nope',
        '[]',
        'null',
        '{"type":"image"}',
        '{"type":"nope","mediaKey":"AA==","directPath":"/x","url":null,"sha256":null,"length":1}',
        '{"type":"image","mediaKey":"AA==","directPath":null,"url":null,"sha256":null,"length":1}',
        '{"type":"image","mediaKey":"AA==","directPath":"/x","url":null,"sha256":null,"length":-1}',
      ]) {
        expect(parseAttachmentHandle(bad)).toBe(null);
      }
      expect(
        parseAttachmentHandle(
          attachmentHandle({
            type: 'video',
            mediaKey: 'AA==',
            directPath: null,
            url: 'https://example.invalid/x',
            sha256: null,
            length: null,
          }),
        )?.type,
      ).toBe('video');
    });

    await it('downloads with the key from the handle and fills the sink', async () => {
      const { download, asked } = fakeDownloader([PLAIN.slice(0, 3), PLAIN.slice(3)]);
      await withBackend(download, async (fetch) => {
        const sink = new MemorySink();
        const result = await fetch(handleOf(), sink);
        expect(result.size).toBe(PLAIN.byteLength);
        expect(sink.size).toBe(PLAIN.byteLength);
        expect(asked.length).toBe(1);
        expect(asked[0]!.type).toBe('image');
        expect(asked[0]!.directPath).toBe('/v/t62.7118-24/synthetic');
        expect(asked[0]!.mediaKey).toStrictEqual(KEY);
      });
    });

    await it('refuses over the limit, announced or streamed', async () => {
      const { download, asked } = fakeDownloader([PLAIN]);
      await withBackend(download, async (fetch) => {
        expect(await failure(fetch(handleOf(), new MemorySink(), 4))).not.toBe(null);
        expect(asked.length).toBe(0);
        const unannounced = handleOf({ fileLength: null, fileSha256: null });
        expect(await failure(fetch(unannounced, new MemorySink(), 4))).not.toBe(null);
        expect(asked.length).toBe(1);
      });
    });

    await it('refuses a length or checksum mismatch', async () => {
      const { download } = fakeDownloader([PLAIN]);
      await withBackend(download, async (fetch) => {
        const wrongLength = await failure(fetch(handleOf({ fileLength: 9 }), new MemorySink()));
        expect(wrongLength?.includes('9')).toBe(true);
        const wrongSum = await failure(
          fetch(handleOf({ fileSha256: sha(new Uint8Array([9])) }), new MemorySink()),
        );
        expect(wrongSum?.includes('checksum') || wrongSum?.includes('Prüfsumme')).toBe(true);
        // No announced digest: nothing to check against, the bytes are accepted.
        const bare = handleOf({ fileSha256: null, fileLength: null });
        expect((await fetch(bare, new MemorySink())).size).toBe(PLAIN.byteLength);
      });
    });

    await it('names the HTTP status and never the error text when the CDN no longer has the file', async () => {
      const { download } = fakeDownloader([], 404);
      await withBackend(download, async (fetch) => {
        const message = await failure(fetch(handleOf(), new MemorySink()));
        expect(message?.includes('404')).toBe(true);
        expect(message?.includes('secret')).toBe(false);
        expect(message?.includes('example.invalid')).toBe(false);
      });
    });

    await it('refuses a handle it did not write, and an account that does not exist', async () => {
      const { download, asked } = fakeDownloader([PLAIN]);
      await withBackend(download, async (fetch) => {
        expect(await failure(fetch('not a handle', new MemorySink()))).not.toBe(null);
        expect(asked.length).toBe(0);
      });
      const dir = tempDir();
      try {
        const backend = new WhatsAppBackend(context(dir), { createMediaDownloader: () => download });
        expect(await failure(backend.openAttachments('whatsapp-0'))).not.toBe(null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
