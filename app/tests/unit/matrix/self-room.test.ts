import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MatrixBackend } from '@curlew/matrix';

import { ANNA, FakeMatrixApi, fakeConnector, ME, seedAccount } from './fake-api.ts';

// Synthetic only: a fake homeserver answering the member list, users on example.org.
const ROOM = '!notes:example.org';
const MEMBERS_PATH = `/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/members`;

const member = (userId: string, membership: string) => ({
  type: 'm.room.member',
  state_key: userId,
  content: { membership },
});

async function isSelf(
  to: string,
  answer: { status: number; body?: unknown } | Error,
): Promise<{ self: boolean; calls: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-matrix-self-'));
  try {
    const accountId = seedAccount(dir);
    const calls: string[] = [];
    const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
      if (answer instanceof Error) throw answer;
      if (url.pathname !== MEMBERS_PATH) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
    }) as typeof globalThis.fetch;
    const backend = new MatrixBackend(
      { settings: {}, env: {}, secretsDir: dir },
      fakeConnector(new FakeMatrixApi()),
      http,
    );
    return { self: await backend.isSelfAddress(accountId, to), calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async () => {
  await describe('Matrix self room', async () => {
    await it('knows its own user id without asking the homeserver', async () => {
      const { self, calls } = await isSelf(ME, new Error('must not be called'));
      expect(self).toBe(true);
      expect(calls.length).toBe(0);
    });

    await it('treats a room with only the account as self', async () => {
      const { self, calls } = await isSelf(ROOM, { status: 200, body: { chunk: [member(ME, 'join')] } });
      expect(self).toBe(true);
      expect(calls).toStrictEqual([`GET ${MEMBERS_PATH}?not_membership=leave`]);
    });

    await it('does not treat a room with somebody else joined as self', async () => {
      const chunk = [member(ME, 'join'), member(ANNA, 'join')];
      expect((await isSelf(ROOM, { status: 200, body: { chunk } })).self).toBe(false);
    });

    await it('does not treat a room with a pending invite as self', async () => {
      const chunk = [member(ME, 'join'), member(ANNA, 'invite')];
      expect((await isSelf(ROOM, { status: 200, body: { chunk } })).self).toBe(false);
    });

    await it('fails closed on an error, an empty or an odd answer', async () => {
      expect((await isSelf(ROOM, { status: 403 })).self).toBe(false);
      expect((await isSelf(ROOM, new Error('offline'))).self).toBe(false);
      expect((await isSelf(ROOM, { status: 200, body: { chunk: [] } })).self).toBe(false);
      expect((await isSelf(ROOM, { status: 200, body: { nothing: true } })).self).toBe(false);
    });

    await it('does not ask about an address that is no room', async () => {
      const { self, calls } = await isSelf(ANNA, { status: 200, body: { chunk: [member(ME, 'join')] } });
      expect(self).toBe(false);
      expect(calls.length).toBe(0);
    });
  });
};
