import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aesGcmEncrypt } from '@curlew/omemo';
import type { AccountPrompter, BackendContext, ByteSink } from '@curlew/protocol';
import { isAttachmentFetcherBackend } from '@curlew/protocol';
import {
  accountIdFor,
  attachmentHandle,
  buildPage,
  type ChatContext,
  isPublicHost,
  mimeOfName,
  NS,
  parseAttachmentHandle,
  parseAttachmentLink,
  XMPP_MANIFEST,
  XmppBackend,
} from '@curlew/xmpp';

import { ANNA, entry, fakeFactory, fakeServer, ME } from './fake-api.ts';

// Synthetic only: random key, plain bytes, a fake file server, no network.
const KEY = new Uint8Array(32).map((_, i) => (i * 5 + 1) % 256);
const IV = new Uint8Array(12).map((_, i) => i + 1);
const PLAIN = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const AESGCM = `aesgcm://files.example.org/up/pic.jpg#${hex(IV)}${hex(KEY)}`;

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

const prompter = (answers: string[]): AccountPrompter => {
  const queue = [...answers];
  return { ask: async () => queue.shift() ?? '', notify: () => {} };
};

const context = (dir: string): BackendContext => ({
  settings: {},
  env: {},
  secretsDir: join(dir, 'secrets', 'xmpp'),
});

const chatContext: ChatContext = { kind: 'direct', chatJid: ANNA, selfJid: ME, selfNick: null, name: null };

const at = (minute: number) => `2026-01-10T10:${String(minute).padStart(2, '0')}:00Z`;

function pageOf(body: string, extra = '') {
  return buildPage(chatContext, [entry({ id: 'm1', at: at(1), from: ANNA, body, extra })], {
    afterSeq: null,
    exhausted: true,
    reachedStart: true,
  }).messages[0]!;
}

interface Served {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

/** A fake file server: one scripted answer per URL, the requests it saw recorded. */
function fakeFetch(routes: Record<string, Served>) {
  const seen: { url: string; redirect: string | undefined }[] = [];
  const fetchFn = (async (input: string, init?: RequestInit) => {
    seen.push({ url: String(input), redirect: init?.redirect });
    const route = routes[String(input)];
    if (!route) return new Response(null, { status: 404 });
    return new Response((route.body ?? new Uint8Array()) as BodyInit | undefined, {
      status: route.status ?? 200,
      headers: route.headers,
    });
  }) as typeof globalThis.fetch;
  return { fetchFn, seen };
}

async function withBackend<T>(
  routes: Record<string, Served>,
  body: (
    fetch: (
      link: string,
      sink: ByteSink,
      maxBytes?: number,
    ) => Promise<{ mimeType: string | null; size: number }>,
    seen: { url: string; redirect: string | undefined }[],
  ) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-xmpp-att-'));
  const { fetchFn, seen } = fakeFetch(routes);
  try {
    await new XmppBackend(context(dir), fakeFactory(fakeServer())).addAccount(
      prompter([ME, 'correct horse', '']),
    );
    const backend = new XmppBackend(context(dir), fakeFactory(fakeServer()), undefined, fetchFn);
    expect(isAttachmentFetcherBackend(backend)).toBe(true);
    return await body(
      async (link, sink, maxBytes = 1000) =>
        (await backend.openAttachments(accountIdFor(ME))).fetchAttachment(
          { backend: 'xmpp', accountId: accountIdFor(ME) },
          { kind: 'image', handle: attachmentHandle(link) },
          sink,
          { maxBytes },
        ),
      seen,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async () => {
  await describe('XMPP attachments', async () => {
    await it('claims reading but not sending in its manifest', async () => {
      expect(XMPP_MANIFEST.capabilities.attachmentsRead).toBe(true);
      expect(XMPP_MANIFEST.capabilities.attachments).toBe(false);
    });

    await it('accepts https and well-formed aesgcm links', async () => {
      const plain = parseAttachmentLink('https://files.example.org/up/a%20b.png');
      expect(plain?.fetchUrl).toBe('https://files.example.org/up/a%20b.png');
      expect(plain?.filename).toBe('a b.png');
      expect(plain?.aesgcm).toBe(null);
      const sealedLink = parseAttachmentLink(AESGCM);
      expect(sealedLink?.fetchUrl).toBe('https://files.example.org/up/pic.jpg');
      expect(sealedLink?.aesgcm?.iv.byteLength).toBe(12);
      expect(sealedLink?.aesgcm?.key.byteLength).toBe(32);
      const iv16 = parseAttachmentLink(`aesgcm://files.example.org/x#${hex(new Uint8Array(16))}${hex(KEY)}`);
      expect(iv16?.aesgcm?.iv.byteLength).toBe(16);
    });

    await it('refuses everything else', async () => {
      for (const bad of [
        'http://files.example.org/a.png',
        'ftp://files.example.org/a.png',
        'https://user:pw@files.example.org/a.png',
        'https://localhost/a.png',
        'https://192.168.1.5/a.png',
        'https://10.0.0.1/a.png',
        'https://[::1]/a.png',
        'https://nas.local/a.png',
        'https://printer/a.png',
        'aesgcm://files.example.org/x#zz',
        'aesgcm://files.example.org/x',
        `aesgcm://files.example.org/x#${hex(KEY)}`,
        'not a url',
      ]) {
        expect(parseAttachmentLink(bad)).toBe(null);
      }
      expect(isPublicHost('example.org')).toBe(true);
      expect(isPublicHost('172.32.0.1')).toBe(true);
      expect(isPublicHost('172.16.0.1')).toBe(false);
      expect(mimeOfName('x.JPG')).toBe('image/jpeg');
      expect(mimeOfName('x')).toBe(null);
    });

    await it('reads back only the handles it wrote', async () => {
      expect(parseAttachmentHandle(attachmentHandle('https://files.example.org/a.png'))?.filename).toBe(
        'a.png',
      );
      for (const bad of ['', 'nope', '[]', 'null', '{"url":3}', '{"url":"http://files.example.org/a.png"}']) {
        expect(parseAttachmentHandle(bad)).toBe(null);
      }
    });

    await it('maps an upload into one attachment row and drops its URL text', async () => {
      const url = 'https://files.example.org/up/pic.png';
      const message = pageOf(url, `<x xmlns="${NS.oob}"><url>${url}</url></x>`);
      expect(message.hasAttachments).toBe(true);
      expect(message.text).toBe(null);
      const row = message.attachments![0]!;
      expect(row.kind).toBe('image');
      expect(row.mimeType).toBe('image/png');
      expect(row.filename).toBe('pic.png');
      expect(row.size).toBe(null);
      const captioned = pageOf('look', `<x xmlns="${NS.oob}"><url>${url}</url></x>`);
      expect(captioned.text).toBe('look');
    });

    await it('maps a decrypted aesgcm body into a row, and gives a LAN link none', async () => {
      const message = pageOf(AESGCM);
      expect(message.text).toBe(null);
      expect(message.attachments?.length).toBe(1);
      const lan = 'https://nas.local/a.png';
      const lanMessage = pageOf(lan, `<x xmlns="${NS.oob}"><url>${lan}</url></x>`);
      expect(lanMessage.hasAttachments).toBe(true);
      expect(lanMessage.attachments).toBe(undefined);
    });

    await it('streams a plain file and takes the served type unless it says nothing', async () => {
      const url = 'https://files.example.org/up/pic.png';
      await withBackend(
        { [url]: { body: PLAIN, headers: { 'content-type': 'image/webp; charset=x' } } },
        async (fetch, seen) => {
          const sink = new MemorySink();
          const result = await fetch(url, sink);
          expect(result.size).toBe(PLAIN.byteLength);
          expect(result.mimeType).toBe('image/webp');
          expect(sink.size).toBe(PLAIN.byteLength);
          expect(seen[0]!.redirect).toBe('manual');
        },
      );
      await withBackend(
        { [url]: { body: PLAIN, headers: { 'content-type': 'application/octet-stream' } } },
        async (fetch) => {
          expect((await fetch(url, new MemorySink())).mimeType).toBe('image/png');
        },
      );
    });

    await it('decrypts an aesgcm file and writes only verified bytes', async () => {
      const cipher = await aesGcmEncrypt(KEY, IV, PLAIN);
      await withBackend({ 'https://files.example.org/up/pic.jpg': { body: cipher } }, async (fetch) => {
        const sink = new MemorySink();
        const result = await fetch(AESGCM, sink);
        expect(result.size).toBe(PLAIN.byteLength);
        expect(result.mimeType).toBe('image/jpeg');
        expect(sink.size).toBe(PLAIN.byteLength);
      });
      const flipped = new Uint8Array(cipher);
      flipped[cipher.byteLength - 1] ^= 1;
      await withBackend({ 'https://files.example.org/up/pic.jpg': { body: flipped } }, async (fetch) => {
        const sink = new MemorySink();
        expect(await failure(fetch(AESGCM, sink))).not.toBe(null);
        expect(sink.size).toBe(0);
      });
      await withBackend(
        { 'https://files.example.org/up/pic.jpg': { body: new Uint8Array(4) } },
        async (fetch) => {
          expect(await failure(fetch(AESGCM, new MemorySink()))).not.toBe(null);
        },
      );
    });

    await it('refuses a file over the limit, declared or streamed', async () => {
      const url = 'https://files.example.org/up/big.bin';
      await withBackend({ [url]: { body: PLAIN, headers: { 'content-length': '5000' } } }, async (fetch) => {
        const sink = new MemorySink();
        expect(await failure(fetch(url, sink, 100))).not.toBe(null);
        expect(sink.size).toBe(0);
      });
      await withBackend({ [url]: { body: PLAIN } }, async (fetch) => {
        expect(await failure(fetch(url, new MemorySink(), 4))).not.toBe(null);
      });
    });

    await it('names the HTTP status and nothing from the server', async () => {
      await withBackend({ 'https://files.example.org/gone.png': { status: 404 } }, async (fetch) => {
        const message = await failure(fetch('https://files.example.org/gone.png', new MemorySink()));
        expect(message?.includes('404')).toBe(true);
      });
    });

    await it('follows a few redirects by hand and checks every hop', async () => {
      const a = 'https://files.example.org/a.png';
      await withBackend(
        {
          [a]: { status: 302, headers: { location: '/b.png' } },
          'https://files.example.org/b.png': {
            status: 301,
            headers: { location: 'https://cdn.example.net/c.png' },
          },
          'https://cdn.example.net/c.png': { body: PLAIN },
        },
        async (fetch, seen) => {
          const sink = new MemorySink();
          expect((await fetch(a, sink)).size).toBe(PLAIN.byteLength);
          expect(seen.map((s) => s.url).join(' ')).toBe(
            'https://files.example.org/a.png https://files.example.org/b.png https://cdn.example.net/c.png',
          );
        },
      );
      await withBackend(
        {
          [a]: { status: 302, headers: { location: 'https://192.168.0.2/secret.png' } },
          'https://192.168.0.2/secret.png': { body: PLAIN },
        },
        async (fetch, seen) => {
          expect(await failure(fetch(a, new MemorySink()))).not.toBe(null);
          expect(seen.length).toBe(1);
        },
      );
      await withBackend(
        { [a]: { status: 302, headers: { location: 'https://files.example.org/a.png' } } },
        async (fetch, seen) => {
          expect(await failure(fetch(a, new MemorySink()))).not.toBe(null);
          expect(seen.length).toBe(4);
        },
      );
    });

    await it('refuses a handle it did not write, and an account that does not exist', async () => {
      await withBackend({}, async (fetch, seen) => {
        expect(await failure(fetch('http://files.example.org/a.png', new MemorySink()))).not.toBe(null);
        expect(seen.length).toBe(0);
      });
      const dir = mkdtempSync(join(tmpdir(), 'curlew-xmpp-att-'));
      try {
        const backend = new XmppBackend(context(dir), fakeFactory(fakeServer()));
        expect(await failure(backend.openAttachments('xmpp-0'))).not.toBe(null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
