import { describe, expect, it } from '@gjsify/unit';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AvatarSource,
  type BackendAccount,
  type ByteSink,
  type ChatBackend,
  type MessageBackend,
  PLUGIN_API_VERSION,
} from '@curlew/protocol';
import { createDaemonAvatarsHandler, sessionKey } from '../../../src/core/actions/daemon.ts';
import {
  AVATAR_NONE_TTL_MS,
  AVATAR_TTL_MS,
  avatarFiles,
  avatarState,
} from '../../../src/core/lib/avatar-cache.ts';
import {
  DAEMON_MAX_AVATAR_PEERS,
  DAEMON_WIRE_VERSION,
  parseDaemonFetchAvatarsReply,
  parseDaemonFetchAvatarsRequest,
} from '../../../src/core/lib/daemon-bus.ts';

const BACKEND = 'telegram';
const ACCOUNT = 'telegram-42';
const INFO: BackendAccount = { id: ACCOUNT, identity: ACCOUNT, provider: 'telegram' };

interface Fake {
  backend: ChatBackend & { openAvatars: NonNullable<MessageBackend['openAvatars']> };
  opened: () => number;
  fetched: string[];
  closed: () => number;
}

/** A backend whose peers `1` and `2` have a picture; any other has none, `bad` throws. */
function fakeBackend(): Fake {
  let opened = 0;
  let closed = 0;
  const fetched: string[] = [];
  const source: AvatarSource = {
    fetchAvatar: async (peer: string, sink: ByteSink) => {
      fetched.push(peer);
      if (peer === 'bad') throw new Error('boom');
      if (peer !== '1' && peer !== '2') return null;
      await sink.write(new Uint8Array([7, 8, 9]));
      return { mimeType: 'image/jpeg', size: 3 };
    },
    close: async () => {
      closed++;
    },
  };
  const backend = {
    manifest: {
      name: BACKEND,
      displayName: 'Fake',
      pluginApi: PLUGIN_API_VERSION,
      capabilities: {} as never,
      syncModel: 'server-archive',
      native: false,
      addressKinds: ['telegram'],
      terms: null,
    },
    kind: 'chat',
    listAccounts: async () => [INFO],
    connect: async () => {
      throw new Error('not used');
    },
    openAvatars: async () => {
      opened++;
      return source;
    },
  } as unknown as Fake['backend'];
  return { backend, opened: () => opened, fetched, closed: () => closed };
}

function withRoot<T>(body: (root: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'curlew-avatars-'));
  return Promise.resolve(body(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

const request = (peers: string[]) => ({
  v: DAEMON_WIRE_VERSION,
  backend: BACKEND,
  account: ACCOUNT,
  peers,
  maxBytes: 1000,
});

export default async () => {
  await describe('daemon avatars', async () => {
    await it('fetches over one connection, caches pictures and the lack of one', async () => {
      await withRoot(async (root) => {
        const fake = fakeBackend();
        const handler = createDaemonAvatarsHandler({
          backends: new Map([[sessionKey(BACKEND, ACCOUNT), fake.backend]]),
          log: () => {},
          root,
        });
        const reply = await handler(request(['1', '2', '3']));
        expect(reply.kind).toBe('fetched');
        if (reply.kind !== 'fetched') return;
        expect(reply.avatars['3']).toBe(null);
        const one = reply.avatars['1'];
        expect(one?.mimeType).toBe('image/jpeg');
        expect(readFileSync(one!.path).length).toBe(3);
        expect(fake.opened()).toBe(1);
        expect(fake.closed()).toBe(1);

        // Everything is cached now: no second connection.
        const again = await handler(request(['1', '2', '3']));
        expect(again.kind).toBe('fetched');
        expect(fake.opened()).toBe(1);
        expect(avatarState(root, BACKEND, ACCOUNT, '3').kind).toBe('none');
      });
    });

    await it('leaves a failing peer out and keeps the others', async () => {
      await withRoot(async (root) => {
        const fake = fakeBackend();
        const handler = createDaemonAvatarsHandler({
          backends: new Map([[sessionKey(BACKEND, ACCOUNT), fake.backend]]),
          log: () => {},
          root,
        });
        const reply = await handler(request(['bad', '1']));
        if (reply.kind !== 'fetched') throw new Error('expected fetched');
        expect('bad' in reply.avatars).toBe(false);
        expect(reply.avatars['1']?.path === undefined).toBe(false);
        expect(existsSync(avatarFiles(root, BACKEND, ACCOUNT, 'bad').image)).toBe(false);
        expect(existsSync(`${avatarFiles(root, BACKEND, ACCOUNT, 'bad').image}.part`)).toBe(false);
      });
    });

    await it('refreshes a stale picture but still answers with it when the fetch fails', async () => {
      await withRoot(async (root) => {
        const fake = fakeBackend();
        const handler = createDaemonAvatarsHandler({
          backends: new Map([[sessionKey(BACKEND, ACCOUNT), fake.backend]]),
          log: () => {},
          root,
        });
        await handler(request(['1']));
        const { image } = avatarFiles(root, BACKEND, ACCOUNT, '1');
        const old = new Date(Date.now() - AVATAR_TTL_MS - 1000);
        utimesSync(image, old, old);
        expect(avatarState(root, BACKEND, ACCOUNT, '1')).toStrictEqual({
          kind: 'hit',
          path: image,
          stale: true,
        });
        await handler(request(['1']));
        expect(fake.opened()).toBe(2);
        expect(avatarState(root, BACKEND, ACCOUNT, '1')).toStrictEqual({
          kind: 'hit',
          path: image,
          stale: false,
        });
      });
    });

    await it("is not this daemon's to answer without a session or an avatar source", async () => {
      await withRoot(async (root) => {
        const handler = createDaemonAvatarsHandler({ backends: new Map(), log: () => {}, root });
        expect((await handler(request(['1']))).kind).toBe('not-followed');
      });
    });

    await it('looks "no picture" up again sooner than a picture', async () => {
      await withRoot(async (root) => {
        const fake = fakeBackend();
        const handler = createDaemonAvatarsHandler({
          backends: new Map([[sessionKey(BACKEND, ACCOUNT), fake.backend]]),
          log: () => {},
          root,
        });
        await handler(request(['9']));
        const { none } = avatarFiles(root, BACKEND, ACCOUNT, '9');
        const old = new Date(Date.now() - AVATAR_NONE_TTL_MS - 1000);
        utimesSync(none, old, old);
        expect(avatarState(root, BACKEND, ACCOUNT, '9')).toStrictEqual({ kind: 'none', stale: true });
        expect(avatarState(root, BACKEND, ACCOUNT, 'never').kind).toBe('unknown');
      });
    });

    await it('reads requests and replies off the wire and refuses the malformed', async () => {
      expect(parseDaemonFetchAvatarsRequest(JSON.stringify(request(['1']))).peers).toStrictEqual(['1']);
      const bad = (peers: unknown) => JSON.stringify({ ...request(['1']), peers });
      for (const peers of [
        [],
        'x',
        [''],
        [1],
        Array.from({ length: DAEMON_MAX_AVATAR_PEERS + 1 }, () => 'p'),
      ]) {
        let threw = false;
        try {
          parseDaemonFetchAvatarsRequest(bad(peers));
        } catch {
          threw = true;
        }
        expect(threw).toBe(true);
      }
      const ok = parseDaemonFetchAvatarsReply(
        JSON.stringify({
          v: DAEMON_WIRE_VERSION,
          kind: 'fetched',
          avatars: { '1': { path: '/x', mimeType: 'image/jpeg' }, '2': null },
        }),
      );
      expect(ok.kind).toBe('fetched');
      let threw = false;
      try {
        parseDaemonFetchAvatarsReply(
          JSON.stringify({ v: DAEMON_WIRE_VERSION, kind: 'fetched', avatars: { '1': { path: 1 } } }),
        );
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });
};
