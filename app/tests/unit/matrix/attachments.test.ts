import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BackendContext, ByteSink } from '@curlew/protocol';
import { isAttachmentFetcherBackend } from '@curlew/protocol';
import {
  attachmentHandle,
  encryptAttachment,
  MATRIX_MANIFEST,
  MatrixBackend,
  parseAttachmentHandle,
  parseMxc,
  toChatMessage,
} from '@curlew/matrix';

import { ANNA, event, FakeMatrixApi, fakeConnector, HOMESERVER, ME, seedAccount } from './fake-api.ts';

// Synthetic only: a fake fetch, users on example.org, a temporary directory per case.
const T0 = Date.parse('2026-09-01T10:00:00Z');
const AUTH_PATH = '/_matrix/client/v1/media/download/example.org/abc123';
const LEGACY_PATH = '/_matrix/media/v3/download/example.org/abc123';
const MXC = 'mxc://example.org/abc123';

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

const file = (extra: Record<string, unknown> = {}, type = 'm.room.message') =>
  event(type, ANNA, T0, {
    msgtype: 'm.file',
    body: 'report.pdf',
    url: MXC,
    info: { mimetype: 'application/pdf', size: 5 },
    ...extra,
  });

const map = (e: ReturnType<typeof event>) => toChatMessage(e, ME, new Map());

interface Answer {
  status: number;
  body?: Uint8Array | string;
  headers?: Record<string, string>;
}

/** A homeserver answering each URL path once or always from `routes`; records every request. */
function fakeHttp(routes: Record<string, Answer>) {
  const calls: Array<{ method: string; url: string; auth: string | null }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? 'GET', url, auth: headers.get('authorization') });
    const path = new URL(url).pathname;
    const answer = routes[path] ?? { status: 404, body: JSON.stringify({ errcode: 'M_NOT_FOUND' }) };
    const body = typeof answer.body === 'string' ? new TextEncoder().encode(answer.body) : answer.body;
    return new Response((body as BodyInit | undefined) ?? null, {
      status: answer.status,
      headers: answer.headers,
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function withBackend<T>(
  routes: Record<string, Answer>,
  body: (backend: MatrixBackend, accountId: string, http: ReturnType<typeof fakeHttp>) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-matrix-attach-'));
  try {
    const accountId = seedAccount(dir);
    const http = fakeHttp(routes);
    const context: BackendContext = { settings: {}, env: {}, secretsDir: dir };
    const backend = new MatrixBackend(context, fakeConnector(new FakeMatrixApi()), http.fetch);
    return await body(backend, accountId, http);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fetchWith = async (
  backend: MatrixBackend,
  accountId: string,
  handle: string,
  sink: ByteSink,
  maxBytes = 1000,
) =>
  (await backend.openAttachments(accountId)).fetchAttachment(
    { backend: 'matrix', accountId },
    { kind: 'file', handle },
    sink,
    { maxBytes },
  );

export default async () => {
  await describe('Matrix attachments', async () => {
    await it('claims reading and sending in its manifest', async () => {
      expect(MATRIX_MANIFEST.capabilities.attachmentsRead).toBe(true);
      expect(MATRIX_MANIFEST.capabilities.attachments).toBe(true);
    });

    await it('maps a file, an image, a voice note and a sticker with their facts', async () => {
      const doc = map(file())?.attachments?.[0];
      expect(doc?.filename).toBe('report.pdf');
      expect(doc?.mimeType).toBe('application/pdf');
      expect(doc?.kind).toBe('file');
      expect(doc?.size).toBe(5);
      expect(doc?.handle).toBe(attachmentHandle(MXC, 5));
      // The caption is the text, the name comes from `filename`.
      const captioned = map(file({ body: 'look at this', filename: 'report.pdf' }));
      expect(captioned?.text).toBe('look at this');
      expect(captioned?.attachments?.[0]?.filename).toBe('report.pdf');

      const image = map(
        file({ msgtype: 'm.image', body: 'a.png', info: { mimetype: 'image/png', size: 9, w: 800, h: 600 } }),
      )?.attachments?.[0];
      expect(image?.kind).toBe('image');
      expect(image?.width).toBe(800);
      expect(image?.height).toBe(600);

      const voice = map(
        file({ msgtype: 'm.audio', body: 'v.ogg', 'org.matrix.msc3245.voice': {}, info: { duration: 7000 } }),
      )?.attachments?.[0];
      expect(voice?.kind).toBe('voice');
      expect(voice?.durationMs).toBe(7000);
      expect(map(file({ msgtype: 'm.video', body: 'c.mp4' }))?.attachments?.[0]?.kind).toBe('video');

      const sticker = map(file({ msgtype: undefined, body: 'waving' }, 'm.sticker'))?.attachments?.[0];
      expect(sticker?.kind).toBe('image');
      expect(sticker?.filename).toBe(null);
    });

    await it('maps the poster handle and blurHash of a video, and downloads the poster like a file', async () => {
      const thumb = 'mxc://example.org/poster1';
      const video = map(
        file({
          msgtype: 'm.video',
          body: 'c.mp4',
          info: {
            mimetype: 'video/mp4',
            size: 9,
            duration: 4000,
            thumbnail_url: thumb,
            'xyz.amorgan.blurhash': 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
          },
        }),
      )?.attachments?.[0];
      expect(video?.thumbHandle).toBe(attachmentHandle(thumb, null));
      expect(video?.blurHash).toBe('LEHV6nWB2yk8pyo0adR*.7kCMdnj');
      // An encrypted-room poster (`thumbnail_file`) and a foreign URL give none.
      const none = map(file({ info: { mimetype: 'video/mp4', thumbnail_url: 'https://example.org/x' } }))
        ?.attachments?.[0];
      expect(none?.thumbHandle === undefined).toBe(true);

      const routes = {
        '/_matrix/client/v1/media/download/example.org/poster1': {
          status: 200,
          body: new Uint8Array([7, 8, 9]),
        },
      };
      await withBackend(routes, async (backend, accountId) => {
        const sink = new MemorySink();
        const result = await fetchWith(backend, accountId, video!.thumbHandle!, sink);
        expect(result.size).toBe(3);
      });
    });

    await it('maps an encrypted file with its key, and nothing without a usable one', async () => {
      // An encrypted room's file has `file` instead of `url`, and the key rides in the handle —
      // the event is the only place it exists, and the index does not keep events (ADR 0019 §6).
      const { file: key } = await encryptAttachment(new Uint8Array([1, 2, 3]));
      const encrypted = map(file({ url: undefined, file: { url: MXC, ...key } }))?.attachments?.[0];
      expect(encrypted?.handle).toBe(attachmentHandle(MXC, 5, { url: MXC, ...key }));
      expect(parseAttachmentHandle(encrypted!.handle)?.file?.key.k).toBe(key.key.k);
      // A `file` object missing the key or the URI names bytes nobody could read: no row at all.
      expect(
        map(file({ url: undefined, file: { url: MXC, key: {}, iv: 'x', hashes: {} } }))?.attachments ===
          undefined,
      ).toBe(true);
      expect(map(file({ url: 'https://example.org/x' }))?.attachments === undefined).toBe(true);
      expect(
        map(event('m.room.message', ANNA, T0, { msgtype: 'm.text', body: 'hi' }))?.attachments === undefined,
      ).toBe(true);
    });

    await it('reads back only the handles it wrote', async () => {
      expect(parseAttachmentHandle(attachmentHandle(MXC, 12))).toStrictEqual({
        mxc: MXC,
        size: 12,
        file: null,
      });
      expect(parseAttachmentHandle(attachmentHandle(MXC, null))).toStrictEqual({
        mxc: MXC,
        size: null,
        file: null,
      });
      for (const bad of [
        '',
        'nope',
        '[]',
        'null',
        '{"mxc":"https://example.org/x","size":1}',
        '{"mxc":"mxc://a/b/c","size":1}',
      ]) {
        expect(parseAttachmentHandle(bad)).toBe(null);
      }
      expect(parseMxc(MXC)).toStrictEqual({ server: 'example.org', mediaId: 'abc123' });
      expect(parseMxc('mxc://example.org/a/../b')).toBe(null);
    });

    await it('downloads from the own homeserver with the token and fills the sink', async () => {
      const routes = { [AUTH_PATH]: { status: 200, body: new Uint8Array([1, 2, 3, 4, 5]) } };
      await withBackend(routes, async (backend, accountId, http) => {
        expect(isAttachmentFetcherBackend(backend)).toBe(true);
        const sink = new MemorySink();
        const result = await fetchWith(backend, accountId, attachmentHandle(MXC, 5), sink);
        expect(result.size).toBe(5);
        expect(sink.size).toBe(5);
        expect(http.calls.length).toBe(1);
        expect(http.calls[0]!.method).toBe('GET');
        expect(http.calls[0]!.url.startsWith(`${HOMESERVER}${AUTH_PATH}`)).toBe(true);
        expect(http.calls[0]!.auth).toBe('Bearer synthetic-token');
      });
    });

    await it('verifies and decrypts a file from an encrypted room, and refuses swapped bytes', async () => {
      const plaintext = new TextEncoder().encode('what only the room may read');
      const { ciphertext, file: key } = await encryptAttachment(plaintext);
      const handle = attachmentHandle(MXC, ciphertext.byteLength, { url: MXC, ...key });
      await withBackend({ [AUTH_PATH]: { status: 200, body: ciphertext } }, async (backend, accountId) => {
        const sink = new MemorySink();
        const result = await fetchWith(backend, accountId, handle, sink);
        expect(result.size).toBe(plaintext.byteLength);
        // The repository serves `application/octet-stream`; the real type is the event's.
        expect(result.mimeType).toBe(null);
        expect(new TextDecoder().decode(sink.chunks[0])).toBe('what only the room may read');
      });

      // The hash in the event binds the key to those bytes: other bytes are an error, and the
      // sink stays empty rather than receiving something nobody wrote.
      const swapped = Uint8Array.from(ciphertext);
      swapped[0] ^= 0xff;
      await withBackend({ [AUTH_PATH]: { status: 200, body: swapped } }, async (backend, accountId) => {
        const sink = new MemorySink();
        const message = await failure(fetchWith(backend, accountId, handle, sink));
        expect(message?.includes('does not match the hash')).toBe(true);
        expect(sink.size).toBe(0);
      });
    });

    await it('falls back to the legacy endpoint on a server that does not know the new one', async () => {
      const routes = {
        [AUTH_PATH]: { status: 404, body: JSON.stringify({ errcode: 'M_UNRECOGNIZED' }) },
        [LEGACY_PATH]: { status: 200, body: new Uint8Array([1, 2]) },
      };
      await withBackend(routes, async (backend, accountId, http) => {
        const sink = new MemorySink();
        const result = await fetchWith(backend, accountId, attachmentHandle(MXC, 2), sink);
        expect(result.size).toBe(2);
        expect(http.calls.length).toBe(2);
        expect(http.calls[1]!.url.includes('allow_redirect=true')).toBe(true);
      });
    });

    await it('names the errcode and never the body when the homeserver refuses', async () => {
      const routes = {
        [AUTH_PATH]: { status: 403, body: JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'secret words' }) },
      };
      await withBackend(routes, async (backend, accountId) => {
        const message = await failure(
          fetchWith(backend, accountId, attachmentHandle(MXC, 5), new MemorySink()),
        );
        expect(message?.includes('M_FORBIDDEN')).toBe(true);
        expect(message?.includes('secret words')).toBe(false);
      });
    });

    await it('refuses over the limit, announced or streamed', async () => {
      const routes = { [AUTH_PATH]: { status: 200, body: new Uint8Array([1, 2, 3, 4, 5, 6]) } };
      await withBackend(routes, async (backend, accountId, http) => {
        // Announced bigger than the limit: no request at all.
        expect(
          await failure(fetchWith(backend, accountId, attachmentHandle(MXC, 5), new MemorySink(), 4)),
        ).not.toBe(null);
        expect(http.calls.length).toBe(0);
        // Announced small, but the stream outgrows the limit.
        expect(
          await failure(fetchWith(backend, accountId, attachmentHandle(MXC, null), new MemorySink(), 4)),
        ).not.toBe(null);
        // The event announced 5, the homeserver served 6: the event's size is only a hint.
        expect((await fetchWith(backend, accountId, attachmentHandle(MXC, 5), new MemorySink())).size).toBe(
          6,
        );
        // No announcement, within the limit: fine.
        const sink = new MemorySink();
        expect((await fetchWith(backend, accountId, attachmentHandle(MXC, null), sink)).size).toBe(6);
      });
    });

    await it('closes the response stream when the download is refused midway', async () => {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
        },
        cancel() {
          cancelled = true;
        },
      });
      const http = (async () => new Response(stream, { status: 200 })) as unknown as typeof globalThis.fetch;
      const dir = mkdtempSync(join(tmpdir(), 'curlew-matrix-attach-'));
      try {
        const accountId = seedAccount(dir);
        const context: BackendContext = { settings: {}, env: {}, secretsDir: dir };
        const backend = new MatrixBackend(context, fakeConnector(new FakeMatrixApi()), http);
        const message = await failure(
          fetchWith(backend, accountId, attachmentHandle(MXC, null), new MemorySink(), 4),
        );
        expect(message).not.toBe(null);
        expect(cancelled).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('refuses a body shorter than the homeserver declared', async () => {
      const routes = {
        [AUTH_PATH]: { status: 200, body: new Uint8Array([1, 2, 3]), headers: { 'content-length': '5' } },
      };
      await withBackend(routes, async (backend, accountId) => {
        const message = await failure(
          fetchWith(backend, accountId, attachmentHandle(MXC, 3), new MemorySink()),
        );
        expect(message).not.toBe(null);
      });
    });

    await it('refuses a handle it did not write', async () => {
      await withBackend({}, async (backend, accountId, http) => {
        expect(await failure(fetchWith(backend, accountId, 'not a handle', new MemorySink()))).not.toBe(null);
        expect(http.calls.length).toBe(0);
      });
    });
  });
};
