import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BackendContext, SendPermit } from '@curlew/protocol';
import { isSendBackend } from '@curlew/protocol';
import {
  MATRIX_MANIFEST,
  MATRIX_MAX_MESSAGE_BYTES,
  MatrixBackend,
  readOnlyFetch,
  sendRefusal,
} from '@curlew/matrix';
import { chatConversationId, getConversation, rebuildConversations, syncChats } from '@curlew/store';

import { openIndex } from '../../../src/core/actions/index.ts';
import { sendMessage } from '../../../src/core/actions/send.ts';
import { withSendGateGrants } from '../../../src/frontends/mcp/tools/send.ts';
import { ANNA, FakeMatrixApi, fakeConnector, HOMESERVER, ME, seedAccount, text } from './fake-api.ts';

/**
 * The Matrix send path without a homeserver: the grant, the permit, the one PUT it makes, the
 * refusal in an encrypted room, the byte limit, and the read client's inability to reach any of
 * it. Everything is synthetic — a fake fetch, a fake sync connector, users on `example.org` and a
 * temporary directory per case.
 */

const V3 = '/_matrix/client/v3';
const HS = `${HOMESERVER}${V3}`;
const ROOM = '!dm:example.org';
const OTHER = '!other:example.org';
/** The event id the fake homeserver assigns to the first accepted message. */
const SENT = '$sent1:example.org';
const T0 = Date.parse('2026-09-01T10:00:00Z');

const encodeRoom = (roomId: string): string => encodeURIComponent(roomId);
const sendPath = (roomId: string): string => `${V3}/rooms/${encodeRoom(roomId)}/send/m.room.message/`;

interface Call {
  method: string;
  url: string;
  body: string | null;
}

interface FakeHttp {
  fetch: typeof globalThis.fetch;
  calls: Call[];
  puts(): Call[];
  gets(): Call[];
}

/**
 * A homeserver that answers the two requests a send makes: the encryption-state read and the PUT.
 *
 * `encrypted` names the rooms that have `m.room.encryption` state; `stateStatus` makes the state
 * read fail with something that is neither "encrypted" nor "not found".
 */
function fakeHttp(options: { encrypted?: readonly string[]; stateStatus?: number } = {}): FakeHttp {
  const calls: Call[] = [];
  const encrypted = new Set(options.encrypted ?? []);
  // A real homeserver gives every accepted event its own id; two messages that shared one would
  // be one row in the index, which is what a reused id would quietly test instead.
  let accepted = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : null });
    const path = new URL(url).pathname;
    const state = new RegExp(`^${V3}/rooms/([^/]+)/state/m\\.room\\.encryption$`).exec(path);
    if (method === 'GET' && state) {
      if (options.stateStatus !== undefined) return new Response('{}', { status: options.stateStatus });
      return encrypted.has(decodeURIComponent(state[1]))
        ? new Response(JSON.stringify({ algorithm: 'm.megolm.v1.aes-sha2' }), { status: 200 })
        : new Response(JSON.stringify({ errcode: 'M_NOT_FOUND', error: 'Event not found.' }), {
            status: 404,
          });
    }
    if (method === 'PUT' && path.includes('/send/')) {
      accepted += 1;
      return new Response(JSON.stringify({ event_id: `$sent${accepted}:example.org` }), { status: 200 });
    }
    return new Response(JSON.stringify({ errcode: 'M_UNRECOGNIZED' }), { status: 404 });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    puts: () => calls.filter((c) => c.method === 'PUT'),
    gets: () => calls.filter((c) => c.method === 'GET'),
  };
}

interface Rig {
  dir: string;
  configPath: string;
  accountId: string;
  backend: MatrixBackend;
  http: FakeHttp;
  api: FakeMatrixApi;
  connector: ReturnType<typeof fakeConnector>;
}

const granted = (accountId: string) => ({
  grants: [{ capability: 'matrix.send', target: `${accountId}/${ROOM}` }],
});

/** A temporary directory with a seeded account, a config, a fake homeserver and a backend over it. */
async function withRig<T>(
  config: (accountId: string) => unknown,
  body: (rig: Rig) => Promise<T>,
  options: { encrypted?: readonly string[]; stateStatus?: number } = {},
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-matrix-send-'));
  try {
    const accountId = seedAccount(dir);
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config(accountId)));
    const api = new FakeMatrixApi();
    api.addRoom({
      roomId: ROOM,
      name: 'Anna Example',
      direct: true,
      members: [{ userId: ANNA, displayName: 'Anna Example' }],
    });
    const http = fakeHttp(options);
    const connector = fakeConnector(api);
    const context: BackendContext = { settings: {}, env: {}, secretsDir: dir };
    const backend = new MatrixBackend(context, connector, http.fetch);
    return await body({ dir, configPath, accountId, backend, http, api, connector });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const send = (rig: Rig, to: string, text: string) =>
  sendMessage({
    accountId: rig.accountId,
    to,
    text,
    frontend: 'cli',
    dbPath: join(rig.dir, 'index.db'),
    configPath: rig.configPath,
    writeLogPath: join(rig.dir, 'writes.log'),
    backend: rig.backend,
  });

async function refused(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

export default async () => {
  await describe('Matrix sending', async () => {
    await it('is a send backend, plain text only', async () => {
      await withRig(granted, async ({ backend, accountId, http }) => {
        expect(isSendBackend(backend)).toBe(true);
        expect(MATRIX_MANIFEST.name).toBe('matrix');
        const sender = await backend.openSender(accountId, { account: accountId, addresses: [ROOM] });
        expect(sender.features.markdown).toBe(false);
        expect(sender.sendImage === undefined).toBe(true);
        await sender.close();
        // Opening a sender talks to nobody: no sync, no crypto store, not even a request.
        expect(http.calls.length).toBe(0);
      });
    });

    await it('refuses without a matrix.send grant, before anything is opened', async () => {
      for (const config of [
        () => ({ grants: [] }),
        // A grant for another backend's send, for exactly this pair, is still not this one.
        (accountId: string) => ({
          grants: [{ capability: 'telegram.send', target: `${accountId}/${ROOM}` }],
        }),
      ]) {
        await withRig(config, async (rig) => {
          expect(await refused(send(rig, ROOM, 'Hallo'))).toBe(true);
          expect(rig.http.calls.length).toBe(0);
          expect(rig.connector.sessions.length).toBe(0);
        });
      }
    });

    await it('refuses a room the grant does not name — in the action and in the sender', async () => {
      await withRig(granted, async (rig) => {
        expect(await refused(send(rig, OTHER, 'Hallo'))).toBe(true);
        expect(rig.http.calls.length).toBe(0);

        const permit: SendPermit = { account: rig.accountId, addresses: [ROOM] };
        const sender = await rig.backend.openSender(rig.accountId, permit);
        expect(await refused(sender.send({ to: OTHER, text: 'Hallo' }))).toBe(true);
        expect(await refused(sender.send({ to: '@anna:example.org', text: 'Hallo' }))).toBe(true);
        expect(rig.http.calls.length).toBe(0);
        await sender.close();

        // And the transport under it is the second wall: the permit's room only.
        expect(sendRefusal('PUT', `${HS}/rooms/${encodeRoom(ROOM)}/send/m.room.message/t1`, [ROOM])).toBe(
          null,
        );
        expect(
          sendRefusal('PUT', `${HS}/rooms/${encodeRoom(OTHER)}/send/m.room.message/t1`, [ROOM]) !== null,
        ).toBe(true);
        // Nothing else becomes writable with a permit in hand.
        expect(
          sendRefusal('POST', `${HS}/rooms/${encodeRoom(ROOM)}/receipt/m.read/$e`, [ROOM]) !== null,
        ).toBe(true);
        expect(sendRefusal('PUT', `${HS}/rooms/${encodeRoom(ROOM)}/redact/$e/t1`, [ROOM]) !== null).toBe(
          true,
        );
      });
    });

    await it('sends to a room id without a server part (room version 12)', async () => {
      await withRig(granted, async (rig) => {
        const v12 = '!31hneApxJ_1o-63DmFrpeqnkFfWppnzWso1JvH3ogLM';
        const sender = await rig.backend.openSender(rig.accountId, {
          account: rig.accountId,
          addresses: [v12],
        });
        await sender.send({ to: v12, text: 'Hallo' });
        expect(new URL(rig.http.puts()[0].url).pathname.startsWith(sendPath(v12))).toBe(true);
        expect(await refused(sender.send({ to: '!other', text: 'Hallo' }))).toBe(true);
        await sender.close();
      });
    });

    await it('sends one PUT with a transaction id, logs matrix.send, and indexes the message', async () => {
      await withRig(granted, async (rig) => {
        const out = await send(rig, ROOM, 'Hallo Anna');
        expect(out.backend).toBe('matrix');
        expect(out.target).toBe(`${rig.accountId}/${ROOM}`);
        expect(out.originId).toBe(SENT);
        expect(out.chatJid).toBe(ROOM);

        // The encryption state is read first, and only then is anything sent.
        expect(rig.http.calls.map((c) => c.method).join()).toBe('GET,PUT');
        expect(new URL(rig.http.gets()[0].url).pathname).toBe(
          `${V3}/rooms/${encodeRoom(ROOM)}/state/m.room.encryption`,
        );
        const put = rig.http.puts()[0];
        const path = new URL(put.url).pathname;
        expect(path.startsWith(sendPath(ROOM))).toBe(true);
        const txnId = decodeURIComponent(path.slice(sendPath(ROOM).length));
        expect(txnId.length > 0).toBe(true);
        expect(txnId.includes('/')).toBe(false);
        expect(put.body).toBe(JSON.stringify({ msgtype: 'm.text', body: 'Hallo Anna' }));

        // A second message is a second transaction: Matrix deduplicates a repeated id.
        const again = await send(rig, ROOM, 'Noch etwas');
        expect(again.originId === out.originId).toBe(false);
        expect(rig.http.puts().length).toBe(2);
        const second = new URL(rig.http.puts()[1].url).pathname.slice(sendPath(ROOM).length);
        expect(second === txnId).toBe(false);

        const lines = readFileSync(join(rig.dir, 'writes.log'), 'utf8').trim().split('\n');
        expect(lines.length).toBe(2);
        const line = JSON.parse(lines[0]);
        expect(line.capability).toBe('matrix.send');
        expect(line.target).toBe(`${rig.accountId}/${ROOM}`);
        expect(line.id).toBe(out.originId);
        expect(line.text === undefined).toBe(true);

        const db = openIndex(join(rig.dir, 'index.db'));
        try {
          const view = getConversation(db, chatConversationId('matrix', rig.accountId, ROOM), {
            includeBodies: true,
          });
          expect(view?.messages.length).toBe(2);
          expect(view?.messages[0].fromSelf).toBe(true);
          expect(view?.messages[0].bodyText).toBe('Hallo Anna');
        } finally {
          db.close();
        }
      });
    });

    await it('refuses an encrypted room and sends nothing into it', async () => {
      await withRig(
        granted,
        async (rig) => {
          const reason = await reasonOf(send(rig, ROOM, 'Hallo'));
          expect(reason.includes('end-to-end encrypted')).toBe(true);
          expect(reason.includes(ROOM)).toBe(true);
          expect(rig.http.puts().length).toBe(0);
        },
        { encrypted: [ROOM] },
      );

      // The guarded transport names `m.room.message` literally, so a granted handle could not
      // put a Megolm event through even if the check above were gone.
      expect(
        sendRefusal('PUT', `${HS}/rooms/${encodeRoom(ROOM)}/send/m.room.encrypted/t1`, [ROOM]) !== null,
      ).toBe(true);
    });

    await it('treats an unanswerable encryption state as a reason not to send', async () => {
      await withRig(
        granted,
        async (rig) => {
          const reason = await reasonOf(send(rig, ROOM, 'Hallo'));
          expect(reason.includes('did not say whether')).toBe(true);
          expect(reason.includes('HTTP 502')).toBe(true);
          expect(rig.http.puts().length).toBe(0);
        },
        { stateStatus: 502 },
      );
    });

    await it('refuses text over the byte limit instead of splitting it', async () => {
      await withRig(granted, async (rig) => {
        // Two bytes per character: the limit counts UTF-8 bytes, not characters.
        const long = 'ä'.repeat(MATRIX_MAX_MESSAGE_BYTES / 2 + 1);
        expect(long.length < MATRIX_MAX_MESSAGE_BYTES).toBe(true);
        expect(await refused(send(rig, ROOM, long))).toBe(true);
        expect(rig.http.calls.length).toBe(0);

        const ok = await send(rig, ROOM, 'x'.repeat(MATRIX_MAX_MESSAGE_BYTES));
        expect(ok.originId).toBe(SENT);
        expect(rig.http.puts().length).toBe(1);
      });
    });

    await it('keeps the read session unable to send', async () => {
      await withRig(granted, async ({ backend, accountId, http }) => {
        const session = await backend.connect(accountId);
        expect('send' in session).toBe(false);
        expect('sendText' in session).toBe(false);
        await session.close();
        // The sync client has its own transport; the send fetch was never handed to it.
        expect(http.calls.length).toBe(0);

        const sent: string[] = [];
        const inner = (async (input: string | URL | Request) => {
          sent.push(String(input));
          return new Response('{}');
        }) as typeof globalThis.fetch;
        const read = readOnlyFetch(inner);
        for (const roomId of [ROOM, OTHER]) {
          expect(
            await refused(
              read(`${HS}/rooms/${encodeRoom(roomId)}/send/m.room.message/t1`, { method: 'PUT' }),
            ),
          ).toBe(true);
        }
        expect(sent.length).toBe(0);
      });
    });

    await it('replaces the local echo when the message comes back on the next sync', async () => {
      await withRig(granted, async (rig) => {
        const out = await send(rig, ROOM, 'Hallo Anna');
        expect(out.messageId !== null).toBe(true);

        // The homeserver's copy of what was just sent, with the event id it answered with.
        rig.api.post(ROOM, { ...text(ME, T0, 'Hallo Anna'), eventId: SENT });
        const db = openIndex(join(rig.dir, 'index.db'));
        try {
          const result = await syncChats(db, rig.backend);
          expect(result.errors).toBe(0);
          rebuildConversations(db);
          const view = getConversation(db, chatConversationId('matrix', rig.accountId, ROOM), {
            includeBodies: true,
          });
          // One message, not the echo plus the synced copy.
          expect(view?.messages.length).toBe(1);
          expect(view?.messages[0].ref.remoteId).toBe(SENT);
          expect(view?.messages[0].fromSelf).toBe(true);
          expect(view?.messages[0].bodyText).toBe('Hallo Anna');
        } finally {
          db.close();
        }
      });
    });

    await it('serves send_message to the MCP gate with a matrix.send grant alone', async () => {
      const target = `matrix-0123456789abcd/${ROOM}`;
      const union = withSendGateGrants([{ capability: 'matrix.send', target }]);
      expect(union.some((g) => g.capability === 'send' && g.target === target)).toBe(true);
    });
  });
};
