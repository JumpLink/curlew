import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BackendContext, ByteSink } from '@curlew/protocol';
import { MATRIX_MANIFEST, MatrixBackend } from '@curlew/matrix';

import { FakeMatrixApi, fakeConnector, ME, seedAccount } from './fake-api.ts';

// Synthetic only: a fake homeserver on example.org, a temporary directory per case.
const ROOM = '!room:example.org';
const STATE = `/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/state/m.room.avatar`;
const MEMBERS = `/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/joined_members`;
const THUMB = (id: string) => `/_matrix/client/v1/media/thumbnail/example.org/${id}`;
const PICTURE = new Uint8Array([1, 2, 3]);

class MemorySink implements ByteSink {
  readonly chunks: Uint8Array[] = [];
  write(chunk: Uint8Array): void {
    this.chunks.push(chunk);
  }
  close(): void {}
}

interface Answer {
  status: number;
  body?: Uint8Array | string;
  headers?: Record<string, string>;
}

const json = (value: unknown): Answer => ({ status: 200, body: JSON.stringify(value) });

function fakeHttp(routes: Record<string, Answer>) {
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const answer = routes[url.pathname] ?? { status: 404, body: JSON.stringify({ errcode: 'M_NOT_FOUND' }) };
    const body = typeof answer.body === 'string' ? new TextEncoder().encode(answer.body) : answer.body;
    return new Response((body as BodyInit | undefined) ?? null, {
      status: answer.status,
      headers: answer.headers,
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function withSource<T>(
  routes: Record<string, Answer>,
  body: (source: Awaited<ReturnType<MatrixBackend['openAvatars']>>, calls: string[]) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-matrix-avatar-'));
  try {
    const accountId = seedAccount(dir);
    const http = fakeHttp(routes);
    const context: BackendContext = { settings: {}, env: {}, secretsDir: dir };
    const backend = new MatrixBackend(context, fakeConnector(new FakeMatrixApi()), http.fetch);
    const source = await backend.openAvatars(accountId);
    try {
      return await body(source, http.calls);
    } finally {
      await source.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const OPTIONS = { maxBytes: 1000 };
const IMAGE = { status: 200, body: PICTURE, headers: { 'content-type': 'image/png' } };

export default async () => {
  await describe('Matrix avatars', async () => {
    await it('claims avatars in its manifest', async () => {
      expect(MATRIX_MANIFEST.capabilities.avatars).toBe(true);
    });

    await it('fetches the thumbnail of the room picture', async () => {
      await withSource(
        { [STATE]: json({ url: 'mxc://example.org/room' }), [THUMB('room')]: IMAGE },
        async (source) => {
          const sink = new MemorySink();
          const got = await source.fetchAvatar(ROOM, sink, OPTIONS);
          expect(got?.size).toBe(3);
          expect(got?.mimeType).toBe('image/png');
          expect(sink.chunks.length).toBe(1);
        },
      );
    });

    await it('falls back to the other person in a chat of two', async () => {
      const members = json({
        joined: {
          [ME]: { avatar_url: 'mxc://example.org/mine' },
          '@anna:example.org': { avatar_url: 'mxc://example.org/anna' },
        },
      });
      await withSource({ [MEMBERS]: members, [THUMB('anna')]: IMAGE }, async (source) => {
        expect((await source.fetchAvatar(ROOM, new MemorySink(), OPTIONS))?.size).toBe(3);
      });
    });

    await it('has no picture for a group without one, and for a peer that is no room', async () => {
      const group = json({ joined: { [ME]: {}, '@a:example.org': {}, '@b:example.org': {} } });
      await withSource({ [MEMBERS]: group }, async (source, calls) => {
        expect(await source.fetchAvatar(ROOM, new MemorySink(), OPTIONS)).toBe(null);
        expect(await source.fetchAvatar('@anna:example.org', new MemorySink(), OPTIONS)).toBe(null);
        expect(calls.every((path) => !path.includes('thumbnail'))).toBe(true);
      });
    });

    await it('tries the legacy thumbnail on a server without authenticated media', async () => {
      const legacy = '/_matrix/media/v3/thumbnail/example.org/room';
      await withSource(
        { [STATE]: json({ url: 'mxc://example.org/room' }), [legacy]: IMAGE },
        async (source) => {
          expect((await source.fetchAvatar(ROOM, new MemorySink(), OPTIONS))?.size).toBe(3);
        },
      );
    });

    await it('refuses a picture over the limit', async () => {
      await withSource(
        { [STATE]: json({ url: 'mxc://example.org/room' }), [THUMB('room')]: IMAGE },
        async (source) => {
          let message: string | null = null;
          try {
            await source.fetchAvatar(ROOM, new MemorySink(), { maxBytes: 2 });
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          expect(message).toContain('larger than the limit');
        },
      );
    });
  });
};
