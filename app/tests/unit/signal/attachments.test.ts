import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountPrompter, ByteSink } from '@curlew/protocol';
import { isAttachmentFetcherBackend } from '@curlew/protocol';
import {
  accountIdFor,
  attachmentHandle,
  decodeContent,
  encodeContent,
  encryptAttachment,
  parseAttachmentHandle,
  SIGNAL_MANIFEST,
  SignalBackend,
  SignalMapper,
  toBase64,
} from '@curlew/signal';

import { ALICE_ACI, context, groupIdOf, LIB, OWN_ACI, Phone } from './world.ts';

// Synthetic only: a random key, plain bytes, a fake CDN, no network.
const ACCOUNT = accountIdFor(OWN_ACI);
const KEY = new Uint8Array(64).map((_, i) => (i * 7 + 3) % 256);
const PLAIN = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

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

const prompter = (): AccountPrompter => ({ ask: async () => '', notify: () => {} });

type Pointer = {
  contentType?: string;
  fileName?: string;
  cdnKey?: string;
  cdnNumber?: number;
  key?: Uint8Array;
  size?: number;
  digest?: Uint8Array;
  flags?: number;
  width?: number;
  height?: number;
};

/** The padded, encrypted file a CDN would serve, and the pointer a sender would announce for it. */
function sealed(plain = PLAIN, key = KEY) {
  const { data, digest } = encryptAttachment(new Uint8Array([...plain, 0, 0, 0, 0, 0, 0]), key);
  const pointer: Pointer = {
    contentType: 'image/jpeg',
    cdnKey: 'synthetic-key',
    cdnNumber: 3,
    key,
    size: plain.byteLength,
    digest,
    width: 640,
    height: 480,
  };
  return { data, pointer };
}

function mapPointer(pointer: Pointer) {
  const mapper = new SignalMapper(OWN_ACI, groupIdOf);
  const content = decodeContent(
    encodeContent({ dataMessage: { body: 'Foto', timestamp: 1, attachments: [pointer] } }),
  );
  const [event] = mapper.map(content, { senderAci: ALICE_ACI, timestamp: 1, groupId: null }).events;
  if (event?.type !== 'message') throw new Error('expected a message');
  return event.message;
}

const handleOf = (pointer: Pointer): string => mapPointer(pointer).attachments![0]!.handle;

async function withBackend<T>(
  served: Uint8Array,
  body: (
    fetch: (handle: string, sink: ByteSink, maxBytes?: number) => Promise<{ size: number }>,
    asked: string[],
  ) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-signal-att-'));
  const asked: string[] = [];
  try {
    await new SignalBackend(context(dir), { lib: LIB, linkNetwork: () => new Phone().network() }).addAccount(
      prompter(),
    );
    const backend = new SignalBackend(context(dir), {
      lib: LIB,
      download: async (url) => {
        asked.push(url);
        return served;
      },
    });
    expect(isAttachmentFetcherBackend(backend)).toBe(true);
    return await body(
      async (handle, sink, maxBytes = 1000) =>
        (await backend.openAttachments(ACCOUNT)).fetchAttachment(
          { backend: 'signal', accountId: ACCOUNT },
          { kind: 'image', handle },
          sink,
          { maxBytes },
        ),
      asked,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async () => {
  await describe('Signal attachments', async () => {
    await it('claims reading but not sending in its manifest', async () => {
      expect(SIGNAL_MANIFEST.capabilities.attachmentsRead).toBe(true);
      expect(SIGNAL_MANIFEST.capabilities.attachments).toBe(false);
    });

    await it('maps a pointer into an attachment row with its facts and a handle', async () => {
      const message = mapPointer(sealed().pointer);
      expect(message.hasAttachments).toBe(true);
      const row = message.attachments![0]!;
      expect(row.kind).toBe('image');
      expect(row.mimeType).toBe('image/jpeg');
      expect(row.size).toBe(PLAIN.byteLength);
      expect(row.width).toBe(640);
      expect(row.height).toBe(480);
      const handle = parseAttachmentHandle(row.handle);
      expect(handle?.cdnKey).toBe('synthetic-key');
      expect(handle?.cdnNumber).toBe(3);
      expect(handle?.key).toBe(toBase64(KEY));
      expect(
        mapPointer({ ...sealed().pointer, flags: 1, contentType: 'audio/aac' }).attachments![0]!.kind,
      ).toBe('voice');
      expect(mapPointer({ ...sealed().pointer, contentType: 'video/mp4' }).attachments![0]!.kind).toBe(
        'video',
      );
      expect(mapPointer({ ...sealed().pointer, contentType: 'application/pdf' }).attachments![0]!.kind).toBe(
        'file',
      );
    });

    await it('gives a pointer without a key or a CDN address no row', async () => {
      const { pointer } = sealed();
      expect(mapPointer({ ...pointer, key: undefined }).attachments).toBe(undefined);
      expect(mapPointer({ ...pointer, cdnKey: undefined }).attachments).toBe(undefined);
      expect(mapPointer({ ...pointer, key: undefined }).hasAttachments).toBe(true);
    });

    await it('reads back only the handles it wrote', async () => {
      const text = handleOf(sealed().pointer);
      expect(parseAttachmentHandle(text)?.size).toBe(PLAIN.byteLength);
      for (const bad of [
        '',
        'nope',
        '[]',
        'null',
        '{"cdnNumber":3}',
        '{"cdnNumber":3,"cdnKey":null,"cdnId":null,"key":"AA==","digest":null,"size":1}',
        '{"cdnNumber":-1,"cdnKey":"k","cdnId":null,"key":"AA==","digest":null,"size":1}',
        '{"cdnNumber":3,"cdnKey":"k","cdnId":null,"key":"","digest":null,"size":1}',
        '{"cdnNumber":3,"cdnKey":"k","cdnId":null,"key":"AA==","digest":null,"size":-1}',
      ]) {
        expect(parseAttachmentHandle(bad)).toBe(null);
      }
      const legacy = attachmentHandle({
        cdnNumber: 0,
        cdnKey: null,
        cdnId: '1234',
        key: 'AA==',
        digest: null,
        size: null,
      });
      expect(parseAttachmentHandle(legacy)?.cdnId).toBe('1234');
    });

    await it('downloads from the pointer, decrypts and cuts the padding', async () => {
      const { data, pointer } = sealed();
      await withBackend(data, async (fetch, asked) => {
        const sink = new MemorySink();
        const result = await fetch(handleOf(pointer), sink);
        expect(result.size).toBe(PLAIN.byteLength);
        expect(sink.size).toBe(PLAIN.byteLength);
        expect(asked).toStrictEqual(['https://cdn3.signal.org/attachments/synthetic-key']);
      });
    });

    await it('refuses over the limit before it downloads anything', async () => {
      const { data, pointer } = sealed();
      await withBackend(data, async (fetch, asked) => {
        expect(await failure(fetch(handleOf(pointer), new MemorySink(), 4))).not.toBe(null);
        expect(asked.length).toBe(0);
      });
    });

    await it('refuses a tampered download, a wrong digest and a wrong key', async () => {
      const { data, pointer } = sealed();
      const flipped = new Uint8Array(data);
      flipped[20] ^= 1;
      await withBackend(flipped, async (fetch) => {
        const sink = new MemorySink();
        expect(await failure(fetch(handleOf(pointer), sink))).not.toBe(null);
        expect(sink.size).toBe(0);
      });
      await withBackend(data, async (fetch) => {
        const wrongDigest = { ...pointer, digest: new Uint8Array(32).fill(1) };
        expect(await failure(fetch(handleOf(wrongDigest), new MemorySink()))).not.toBe(null);
        const wrongKey = { ...pointer, key: new Uint8Array(64).fill(9), digest: undefined };
        expect(await failure(fetch(handleOf(wrongKey), new MemorySink()))).not.toBe(null);
      });
    });

    await it('refuses a file shorter than announced', async () => {
      const { data, pointer } = sealed();
      await withBackend(data, async (fetch) => {
        const message = await failure(fetch(handleOf({ ...pointer, size: 500 }), new MemorySink()));
        expect(message?.includes('500')).toBe(true);
      });
    });

    await it('names the HTTP status when the CDN no longer has the file, and never the error text', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-signal-att-'));
      try {
        await new SignalBackend(context(dir), {
          lib: LIB,
          linkNetwork: () => new Phone().network(),
        }).addAccount(prompter());
        const backend = new SignalBackend(context(dir), {
          lib: LIB,
          download: async () => {
            throw new Error('the CDN answered 404');
          },
        });
        const fetcher = await backend.openAttachments(ACCOUNT);
        const message = await failure(
          fetcher.fetchAttachment(
            { backend: 'signal', accountId: ACCOUNT },
            { kind: 'image', handle: handleOf(sealed().pointer) },
            new MemorySink(),
            { maxBytes: 1000 },
          ),
        );
        expect(message?.includes('404')).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('refuses a handle it did not write, and an account that does not exist', async () => {
      const { data } = sealed();
      await withBackend(data, async (fetch, asked) => {
        expect(await failure(fetch('not a handle', new MemorySink()))).not.toBe(null);
        expect(asked.length).toBe(0);
      });
      const dir = mkdtempSync(join(tmpdir(), 'curlew-signal-att-'));
      try {
        const backend = new SignalBackend(context(dir), { lib: LIB });
        expect(await failure(backend.openAttachments('signal-0'))).not.toBe(null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
