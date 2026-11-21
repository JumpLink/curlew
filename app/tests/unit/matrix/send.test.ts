import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BackendContext, SendPermit } from '@curlew/protocol';
import { isSendBackend } from '@curlew/protocol';
import {
  attachmentHandle,
  decryptAttachment,
  encryptAttachment,
  encryptedSendRoom,
  liveFetch,
  MATRIX_MANIFEST,
  MATRIX_MAX_MESSAGE_BYTES,
  MatrixBackend,
  MatrixSender,
  MatrixSendWindows,
  matrixSendApi,
  parseAttachmentHandle,
  parseEncryptedFile,
  readOnlyFetch,
  refusals,
  sendRefusal,
} from '@curlew/matrix';
import { chatConversationId, getConversation, rebuildConversations, syncChats } from '@curlew/store';

import { openIndex } from '../../../src/core/actions/index.ts';
import { sendAsAgent } from '../../../src/core/actions/send.ts';
import {
  ANNA,
  FakeEncrypt,
  FakeMatrixApi,
  fakeConnector,
  HOMESERVER,
  ME,
  seedAccount,
  text,
} from './fake-api.ts';

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
  uploads: Uint8Array[];
  puts(): Call[];
  gets(): Call[];
}

interface FakeHttpOptions {
  encrypted?: readonly string[];
  stateStatus?: number;
  /** The reactions each event has, as `[eventId, sender, emoji]`, in the order the homeserver lists them. */
  reactions?: Record<string, ReadonlyArray<readonly [string, string, string]>>;
}

/**
 * A homeserver that answers the two requests a send makes: the encryption-state read and the PUT.
 *
 * `encrypted` names the rooms that have `m.room.encryption` state; `stateStatus` makes the state
 * read fail with something that is neither "encrypted" nor "not found".
 */
function fakeHttp(options: FakeHttpOptions = {}): FakeHttp {
  const calls: Call[] = [];
  const uploads: Uint8Array[] = [];
  const encrypted = new Set(options.encrypted ?? []);
  // A real homeserver gives every accepted event its own id; two messages that shared one would
  // be one row in the index, which is what a reused id would quietly test instead.
  let accepted = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = new URL(url).pathname;
    // Whether a room is a note-to-self room is asked before any grant; it is not part of a send.
    if (method === 'GET' && path.endsWith('/members')) return new Response('{}', { status: 404 });
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : null });
    const state = new RegExp(`^${V3}/rooms/([^/]+)/state/m\\.room\\.encryption$`).exec(path);
    if (method === 'GET' && state) {
      if (options.stateStatus !== undefined) return new Response('{}', { status: options.stateStatus });
      return encrypted.has(decodeURIComponent(state[1]))
        ? new Response(JSON.stringify({ algorithm: 'm.megolm.v1.aes-sha2' }), { status: 200 })
        : new Response(JSON.stringify({ errcode: 'M_NOT_FOUND', error: 'Event not found.' }), {
            status: 404,
          });
    }
    if (method === 'POST' && path === '/_matrix/media/v3/upload') {
      uploads.push(init?.body as Uint8Array);
      return new Response(JSON.stringify({ content_uri: `mxc://example.org/up${uploads.length}` }), {
        status: 200,
      });
    }
    const relations = new RegExp(
      `^/_matrix/client/v1/rooms/[^/]+/relations/([^/]+)/m\\.annotation/m\\.reaction$`,
    ).exec(path);
    if (method === 'GET' && relations) {
      const chunk = (options.reactions?.[decodeURIComponent(relations[1])] ?? []).map(
        ([event_id, sender, key]) => ({ event_id, sender, content: { 'm.relates_to': { key } } }),
      );
      return new Response(JSON.stringify({ chunk }), { status: 200 });
    }
    if (method === 'PUT' && path.includes('/redact/')) {
      return new Response(JSON.stringify({ event_id: '$redaction:example.org' }), { status: 200 });
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
    uploads,
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
  options: FakeHttpOptions = {},
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
  sendAsAgent({
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
    await it('is a send backend, markdown off, files on', async () => {
      await withRig(granted, async ({ backend, accountId, http }) => {
        expect(isSendBackend(backend)).toBe(true);
        expect(MATRIX_MANIFEST.name).toBe('matrix');
        const sender = await backend.openSender(accountId, { account: accountId, addresses: [ROOM] });
        expect(sender.features.markdown).toBe(false);
        expect(sender.features.attachments).toBe(true);
        expect(sender.sendImage === undefined).toBe(true);
        await sender.close();
        // Opening a sender talks to nobody: no sync, no crypto store, not even a request.
        expect(http.calls.length).toBe(0);
      });
    });

    await it('refuses without a matrix.send grant, before anything is opened', async () => {
      for (const config of [() => ({ grants: [] })]) {
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
        // A reaction and its redaction are writes too, for the permit's room only.
        expect(sendRefusal('PUT', `${HS}/rooms/${encodeRoom(ROOM)}/send/m.reaction/t1`, [ROOM])).toBe(null);
        expect(sendRefusal('PUT', `${HS}/rooms/${encodeRoom(ROOM)}/redact/$e/t1`, [ROOM])).toBe(null);
        expect(sendRefusal('PUT', `${HS}/rooms/${encodeRoom(OTHER)}/redact/$e/t1`, [ROOM]) !== null).toBe(
          true,
        );
        expect(
          sendRefusal('PUT', `${HS}/rooms/${encodeRoom(ROOM)}/send/m.room.encrypted/t1`, [ROOM]) !== null,
        ).toBe(true);
      });
    });

    await it('permits the private read receipt in a granted room and nothing wider', async () => {
      const receipt = (room: string, type: string): string =>
        `${HS}/rooms/${encodeRoom(room)}/receipt/${type}/$e`;
      expect(sendRefusal('POST', receipt(ROOM, 'm.read.private'), [ROOM])).toBe(null);
      expect(sendRefusal('POST', receipt(OTHER, 'm.read.private'), [ROOM]) !== null).toBe(true);
      // The public receipt and the fully-read marker tell the other members: still refused.
      expect(sendRefusal('POST', receipt(ROOM, 'm.read'), [ROOM]) !== null).toBe(true);
      expect(sendRefusal('POST', receipt(ROOM, 'm.fully_read'), [ROOM]) !== null).toBe(true);
    });

    await it('syncs the read position with one POST of m.read.private', async () => {
      const calls: Call[] = [];
      const api = matrixSendApi({
        homeserver: HOMESERVER,
        accessToken: 'tok',
        userId: ME,
        fetch: (async (url: unknown, init?: RequestInit) => {
          calls.push({
            method: init?.method ?? 'GET',
            url: String(url),
            body: (init?.body as string) ?? null,
          });
          return new Response('{}', { status: 200 });
        }) as typeof globalThis.fetch,
      });
      const sender = new MatrixSender(api, { account: 'matrix-me', addresses: [ROOM] }, async () => {});
      expect(sender.features.readSync).toBe(true);
      await sender.readSync?.({
        to: ROOM,
        target: { remoteId: '$ev1:example.org', fromSelf: false },
        sentAt: '2026-09-01T10:00:00Z',
      });
      expect(calls.length).toBe(1);
      expect(calls[0].method).toBe('POST');
      expect(calls[0].url).toBe(
        `${HS}/rooms/${encodeRoom(ROOM)}/receipt/m.read.private/${encodeURIComponent('$ev1:example.org')}`,
      );
      expect(calls[0].body).toBe('{}');
      let refused = false;
      try {
        await sender.readSync?.({
          to: OTHER,
          target: { remoteId: '$ev1:example.org' },
          sentAt: '2026-09-01T10:00:00Z',
        });
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
      expect(calls.length).toBe(1);
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

    await it('uploads a file and posts it as m.file, the text as its caption', async () => {
      await withRig(granted, async (rig) => {
        const file = join(rig.dir, 'report.pdf');
        writeFileSync(file, 'pdf bytes');
        const out = await sendAsAgent({
          accountId: rig.accountId,
          to: ROOM,
          text: 'Hier der Bericht',
          attachments: [file],
          frontend: 'cli',
          dbPath: join(rig.dir, 'index.db'),
          configPath: rig.configPath,
          writeLogPath: join(rig.dir, 'writes.log'),
          backend: rig.backend,
        }).catch((err: Error) => err);
        // An agent may not attach to a chat yet (ADR 0010, AP4.6): the sender itself is tested below.
        expect(out instanceof Error).toBe(true);
        expect(rig.http.uploads.length).toBe(0);

        const sender = await rig.backend.openSender(rig.accountId, {
          account: rig.accountId,
          addresses: [ROOM],
        });
        const sent = await sender.send({ to: ROOM, text: 'Hier der Bericht', attachments: [{ path: file }] });
        await sender.close();
        expect(sent.attachments?.[0].filename).toBe('report.pdf');
        expect(rig.http.uploads.length).toBe(1);
        expect(new TextDecoder().decode(rig.http.uploads[0])).toBe('pdf bytes');
        const upload = rig.http.calls.find((c) => c.method === 'POST')!;
        expect(new URL(upload.url).searchParams.get('filename')).toBe('report.pdf');
        const event = JSON.parse(rig.http.puts()[0].body!);
        expect(event.msgtype).toBe('m.file');
        expect(event.body).toBe('Hier der Bericht');
        expect(event.filename).toBe('report.pdf');
        expect(event.url).toBe('mxc://example.org/up1');
        expect(event.info.mimetype).toBe('application/pdf');
        expect(event.info.size).toBe(9);
      });
    });

    await it('sends an image with its size and echoes the row the sync would write', async () => {
      await withRig(granted, async (rig) => {
        // A PNG header for 3x2 pixels: signature, IHDR length, type, width, height.
        const png = Uint8Array.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0,
          0, 0, 2, 8, 6, 0, 0, 0,
        ]);
        const file = join(rig.dir, 'pic.png');
        writeFileSync(file, png);
        const sender = await rig.backend.openSender(rig.accountId, {
          account: rig.accountId,
          addresses: [ROOM],
        });
        const sent = await sender.send({ to: ROOM, text: '', attachments: [{ path: file }] });
        await sender.close();
        const event = JSON.parse(rig.http.puts()[0].body!);
        expect(event.msgtype).toBe('m.image');
        expect(event.info.w).toBe(3);
        expect(event.info.h).toBe(2);
        const echo = sent.echoAttachments?.[0];
        expect(echo?.kind).toBe('image');
        expect(echo?.width).toBe(3);
        expect(echo?.height).toBe(2);
        expect(echo?.size).toBe(png.length);
        expect(echo?.handle).toBe(attachmentHandle('mxc://example.org/up1', png.length));
      });
    });

    await it('sends a video as m.video and an audio file as m.audio', async () => {
      await withRig(granted, async (rig) => {
        const video = join(rig.dir, 'clip.mp4');
        const audio = join(rig.dir, 'song.mp3');
        writeFileSync(video, 'not really a video');
        writeFileSync(audio, 'not really audio');
        const sender = await rig.backend.openSender(rig.accountId, {
          account: rig.accountId,
          addresses: [ROOM],
        });
        const sent = await sender.send({
          to: ROOM,
          text: '',
          attachments: [{ path: video }, { path: audio }],
        });
        await sender.close();
        const events = rig.http.puts().map((p) => JSON.parse(p.body!));
        expect(events.map((e) => e.msgtype).join()).toBe('m.video,m.audio');
        expect(sent.echoAttachments?.map((a) => a.kind).join()).toBe('video,audio');
      });
    });

    await it('reacts with an m.annotation, replaces an earlier emoji and takes it back by redaction', async () => {
      const asks = {
        reactions: {
          '$m:example.org': [
            ['$old:example.org', ME, '👍'],
            ['$other:example.org', ANNA, '❤️'],
          ],
        },
      } as const;
      const opened = (rig: Rig) =>
        rig.backend.openSender(rig.accountId, { account: rig.accountId, addresses: [ROOM] });
      const target = { remoteId: '$m:example.org' };
      const redacted = (rig: Rig) =>
        rig.http
          .puts()
          .filter((c) => c.url.includes('/redact/'))
          .map((c) => decodeURIComponent(new URL(c.url).pathname.split('/redact/')[1].split('/')[0]));
      const reacted = (rig: Rig) =>
        rig.http
          .puts()
          .filter((c) => c.url.includes('/send/m.reaction/'))
          .map((c) => JSON.parse(c.body!));

      await withRig(granted, async (rig) => {
        const sender = await opened(rig);
        expect(sender.features.reactions).toBe(true);
        await sender.react!({ to: ROOM, target, emoji: '🎉' });
        expect(reacted(rig)).toStrictEqual([
          { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$m:example.org', key: '🎉' } },
        ]);
        expect(redacted(rig)).toStrictEqual([]);
      });
      await withRig(
        granted,
        async (rig) => {
          const sender = await opened(rig);
          // One emoji at a time: the earlier one of the person goes, the other person's stays.
          await sender.react!({ to: ROOM, target, emoji: '🎉' });
          expect(redacted(rig)).toStrictEqual(['$old:example.org']);
          expect(reacted(rig).length).toBe(1);
          // The same emoji again changes nothing.
          await sender.react!({ to: ROOM, target, emoji: '👍' });
          expect(reacted(rig).length).toBe(1);
          // Taking it back redacts the person's own event, never the other person's.
          await sender.react!({ to: ROOM, target, emoji: null, previous: '👍' });
          expect(redacted(rig)).toStrictEqual(['$old:example.org', '$old:example.org']);
        },
        asks,
      );
    });

    await it('reacts in an encrypted room too, and refuses a foreign room or a non-event', async () => {
      await withRig(
        granted,
        async (rig) => {
          const sender = await rig.backend.openSender(rig.accountId, {
            account: rig.accountId,
            addresses: [ROOM],
          });
          // Matrix has no encrypted reaction: the emoji and its target are server-visible in
          // every client, so there is nothing here to refuse and nothing to encrypt (ADR 0019 §4).
          await sender.react!({ to: ROOM, target: { remoteId: '$m:example.org' }, emoji: '👍' });
          expect(rig.http.puts().length).toBe(1);
          expect(rig.http.puts()[0].url).toContain('/send/m.reaction/');
          await sender.react!({ to: OTHER, target: { remoteId: '$m:example.org' }, emoji: '👍' }).then(
            () => expect('sent').toBe('refused'),
            () => {},
          );
          await sender.react!({ to: ROOM, target: { remoteId: 'not-an-event' }, emoji: '👍' }).then(
            () => expect('sent').toBe('refused'),
            () => {},
          );
          expect(rig.http.puts().length).toBe(1);
        },
        { encrypted: [ROOM] },
      );
    });

    await it('edits with an m.replace and deletes by redaction, own messages only', async () => {
      const mine = { remoteId: '$m:example.org', fromSelf: true };
      await withRig(granted, async (rig) => {
        const sender = await rig.backend.openSender(rig.accountId, {
          account: rig.accountId,
          addresses: [ROOM],
        });
        expect(sender.features.edits).toBe(true);
        expect(sender.features.deletes).toBe(true);
        await sender.edit!({ to: ROOM, target: mine, text: 'Fixed' });
        expect(JSON.parse(rig.http.puts()[0].body!)).toStrictEqual({
          msgtype: 'm.text',
          body: '* Fixed',
          'm.new_content': { msgtype: 'm.text', body: 'Fixed' },
          'm.relates_to': { rel_type: 'm.replace', event_id: '$m:example.org' },
        });
        expect(rig.http.puts()[0].url).toContain('/send/m.room.message/');
        await sender.delete!({ to: ROOM, target: mine });
        const gone = rig.http.puts()[1];
        expect(decodeURIComponent(new URL(gone.url).pathname.split('/redact/')[1].split('/')[0])).toBe(
          '$m:example.org',
        );
        // Someone else's message, a non-event id, a foreign room and an overlong text change nothing.
        const theirs = { remoteId: '$m:example.org', fromSelf: false };
        for (const attempt of [
          sender.edit!({ to: ROOM, target: theirs, text: 'x' }),
          sender.delete!({ to: ROOM, target: theirs }),
          sender.edit!({ to: ROOM, target: { remoteId: 'nope', fromSelf: true }, text: 'x' }),
          sender.delete!({ to: ROOM, target: { remoteId: 'nope', fromSelf: true } }),
          sender.edit!({ to: OTHER, target: mine, text: 'x' }),
          sender.delete!({ to: OTHER, target: mine }),
          sender.edit!({ to: ROOM, target: mine, text: 'x'.repeat(32_001) }),
        ]) {
          await attempt.then(
            () => expect('sent').toBe('refused'),
            () => {},
          );
        }
        expect(rig.http.puts().length).toBe(2);
        await sender.close();
      });
    });

    await it('refuses an edit it cannot encrypt, and deletes anyway', async () => {
      await withRig(
        granted,
        async (rig) => {
          const sender = await rig.backend.openSender(rig.accountId, {
            account: rig.accountId,
            addresses: [ROOM],
          });
          const mine = { remoteId: '$m:example.org', fromSelf: true };
          // An edit carries text, so it must be encrypted — and this sender has no crypto.
          const reason = await reasonOf(sender.edit!({ to: ROOM, target: mine, text: 'x' }));
          expect(reason.includes('end-to-end encrypted')).toBe(true);
          expect(rig.http.puts().length).toBe(0);
          // A redaction is cleartext in every room: it names an event and removes it.
          await sender.delete!({ to: ROOM, target: mine });
          expect(rig.http.puts().length).toBe(1);
          expect(rig.http.puts()[0].url).toContain('/redact/');
        },
        { encrypted: [ROOM] },
      );
    });

    await it('answers a message with m.in_reply_to, on a text and on the first file only', async () => {
      await withRig(granted, async (rig) => {
        const sender = await rig.backend.openSender(rig.accountId, {
          account: rig.accountId,
          addresses: [ROOM],
        });
        expect(sender.features.replies).toBe(true);
        const replyTo = { remoteId: '$asked:example.org' };
        await sender.send({ to: ROOM, text: 'Gern', replyTo });
        expect(JSON.parse(rig.http.puts()[0].body!)).toStrictEqual({
          msgtype: 'm.text',
          body: 'Gern',
          'm.relates_to': { 'm.in_reply_to': { event_id: '$asked:example.org' } },
        });

        const a = join(rig.dir, 'a.txt');
        const b = join(rig.dir, 'b.txt');
        writeFileSync(a, 'a');
        writeFileSync(b, 'b');
        await sender.send({ to: ROOM, text: '', replyTo, attachments: [{ path: a }, { path: b }] });
        const events = rig.http
          .puts()
          .slice(1)
          .map((put) => JSON.parse(put.body!));
        expect(events.length).toBe(2);
        expect(events[0]['m.relates_to']['m.in_reply_to'].event_id).toBe('$asked:example.org');
        expect('m.relates_to' in events[1]).toBe(false);

        await sender.send({ to: ROOM, text: 'Plain' });
        expect('m.relates_to' in JSON.parse(rig.http.puts()[3].body!)).toBe(false);
        await sender.close();
      });
    });

    await it('refuses a reply target that is not an event id, before anything is sent', async () => {
      await withRig(granted, async (rig) => {
        const sender = await rig.backend.openSender(rig.accountId, {
          account: rig.accountId,
          addresses: [ROOM],
        });
        expect(await refused(sender.send({ to: ROOM, text: 'Hi', replyTo: { remoteId: 'm5' } }))).toBe(true);
        expect(rig.http.puts().length).toBe(0);
        await sender.close();
      });
    });

    await it('sends a picture as m.image, one event per file, caption on the first only', async () => {
      await withRig(granted, async (rig) => {
        const a = join(rig.dir, 'a.png');
        const b = join(rig.dir, 'b.txt');
        writeFileSync(a, 'png');
        writeFileSync(b, 'txt');
        const sender = await rig.backend.openSender(rig.accountId, {
          account: rig.accountId,
          addresses: [ROOM],
        });
        await sender.send({ to: ROOM, text: 'Zwei Dateien', attachments: [{ path: a }, { path: b }] });
        await sender.send({ to: ROOM, text: '', attachments: [{ path: b }] });
        await sender.close();
        const events = rig.http.puts().map((c) => JSON.parse(c.body!));
        expect(events.map((e) => e.msgtype).join()).toBe('m.image,m.file,m.file');
        expect(events[0].body).toBe('Zwei Dateien');
        expect(events[1].body).toBe('b.txt');
        expect(events[2].body).toBe('b.txt');
        expect(rig.http.uploads.length).toBe(3);
      });
    });

    await it('refuses a file in an encrypted room before uploading anything', async () => {
      await withRig(
        granted,
        async (rig) => {
          const file = join(rig.dir, 'a.txt');
          writeFileSync(file, 'x');
          const sender = await rig.backend.openSender(rig.accountId, {
            account: rig.accountId,
            addresses: [ROOM],
          });
          const reason = await reasonOf(sender.send({ to: ROOM, text: '', attachments: [{ path: file }] }));
          await sender.close();
          expect(reason.includes('end-to-end encrypted')).toBe(true);
          expect(rig.http.uploads.length).toBe(0);
        },
        { encrypted: [ROOM] },
      );
    });

    await it('allows the media upload only for a sender, never for the read session', async () => {
      const upload = `${HOMESERVER}/_matrix/media/v3/upload?filename=a.txt`;
      expect(sendRefusal('POST', upload, [ROOM])).toBe(null);
      expect(sendRefusal('POST', `${HOMESERVER}/_matrix/media/v3/create`, [ROOM]) !== null).toBe(true);
      const sent: string[] = [];
      const inner = (async (input: string | URL | Request) => {
        sent.push(String(input));
        return new Response('{}');
      }) as typeof globalThis.fetch;
      expect(await refused(readOnlyFetch(inner)(upload, { method: 'POST' }))).toBe(true);
      expect(sent.length).toBe(0);
    });

    await it('refuses an encrypted room without crypto, naming the daemon', async () => {
      await withRig(
        granted,
        async (rig) => {
          const reason = await reasonOf(send(rig, ROOM, 'Hallo'));
          expect(reason.includes('end-to-end encrypted')).toBe(true);
          expect(reason.includes('daemon')).toBe(true);
          expect(reason.includes(ROOM)).toBe(true);
          expect(rig.http.puts().length).toBe(0);
        },
        { encrypted: [ROOM] },
      );

      // The guarded transport names `m.room.message` literally, so a granted handle could not
      // put a Megolm event through its own fetch: that one endpoint is a send window's alone.
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
  });

  /**
   * The same send path with the live client's crypto in hand (ADR 0019). The crypto is a fake —
   * no WASM, no sync, no IndexedDB — and that is enough to pin the one property that matters:
   * what reaches the plain fetch, and what does not.
   */
  await describe('Matrix sending, encrypted', async () => {
    const withCrypto = (
      options: FakeHttpOptions = {},
      rooms: readonly string[] = [],
    ): { http: FakeHttp; encrypt: FakeEncrypt; sender: MatrixSender } => {
      const http = fakeHttp(options);
      const encrypt = new FakeEncrypt(rooms);
      const api = matrixSendApi(
        { homeserver: HOMESERVER, accessToken: 'tok', userId: ME, fetch: http.fetch },
        encrypt,
      );
      const sender = new MatrixSender(api, { account: 'matrix-me', addresses: [ROOM] }, async () => {});
      return { http, encrypt, sender };
    };
    const messagePuts = (http: FakeHttp): Call[] =>
      http.puts().filter((c) => c.url.includes('/send/m.room.message/'));

    await it('encrypts the message and puts no cleartext event at all', async () => {
      const { http, encrypt, sender } = withCrypto({ encrypted: [ROOM] });
      const sent = await sender.send({ to: ROOM, text: 'Nur für dich' });
      expect(sent.encrypted).toBe(true);
      expect(sent.id).toBe('$enc1:example.org');
      // The one guarantee: not a single `m.room.message` on the wire of this transport.
      expect(messagePuts(http).length).toBe(0);
      expect(encrypt.sent.length).toBe(1);
      expect(encrypt.sent[0].roomId).toBe(ROOM);
      expect(encrypt.sent[0].content).toStrictEqual({ msgtype: 'm.text', body: 'Nur für dich' });
      // Device lists and the room key first, so the event is not built against a stale set.
      expect(encrypt.prepared).toStrictEqual([ROOM]);
    });

    await it("trusts the crypto's own flag and asks the homeserver nothing", async () => {
      // A room the client has synced: the crypto knows, so the state GET is not needed at all.
      const { http, encrypt, sender } = withCrypto({}, [ROOM]);
      const sent = await sender.send({ to: ROOM, text: 'Hallo' });
      expect(sent.encrypted).toBe(true);
      expect(encrypt.sent.length).toBe(1);
      expect(http.gets().length).toBe(0);
    });

    await it('still asks the homeserver when the crypto says no, and then sends in the clear', async () => {
      const { http, encrypt, sender } = withCrypto();
      const sent = await sender.send({ to: ROOM, text: 'Hallo' });
      expect(sent.encrypted).toBe(false);
      // `false` from the crypto is not proof: a room it has not seen answers false too (§3).
      expect(http.gets().length).toBe(1);
      expect(new URL(http.gets()[0].url).pathname).toBe(
        `${V3}/rooms/${encodeRoom(ROOM)}/state/m.room.encryption`,
      );
      expect(messagePuts(http).length).toBe(1);
      expect(encrypt.sent.length).toBe(0);
    });

    await it('refuses rather than guess when the homeserver does not answer', async () => {
      const { http, encrypt, sender } = withCrypto({ stateStatus: 502 });
      const reason = await reasonOf(sender.send({ to: ROOM, text: 'Hallo' }));
      expect(reason.includes('did not say whether')).toBe(true);
      expect(http.puts().length).toBe(0);
      expect(encrypt.sent.length).toBe(0);
    });

    await it('edits through the crypto and redacts in the clear', async () => {
      const { http, encrypt, sender } = withCrypto({ encrypted: [ROOM] });
      const mine = { remoteId: '$m:example.org', fromSelf: true };
      await sender.edit!({ to: ROOM, target: mine, text: 'Fixed' });
      expect(messagePuts(http).length).toBe(0);
      expect(encrypt.sent.length).toBe(1);
      expect(encrypt.sent[0].content['m.relates_to']).toStrictEqual({
        rel_type: 'm.replace',
        event_id: '$m:example.org',
      });
      expect(encrypt.sent[0].content['m.new_content']).toStrictEqual({
        msgtype: 'm.text',
        body: 'Fixed',
      });
      await sender.delete!({ to: ROOM, target: mine });
      expect(http.puts().length).toBe(1);
      expect(http.puts()[0].url).toContain('/redact/');
    });

    await it('uploads the ciphertext and carries the key in the event, never a url', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-matrix-e2ee-'));
      try {
        const file = join(dir, 'secret.txt');
        const plaintext = 'the plain bytes nobody but the room may read';
        writeFileSync(file, plaintext);
        const { http, encrypt, sender } = withCrypto({ encrypted: [ROOM] });
        const sent = await sender.send({ to: ROOM, text: '', attachments: [{ path: file }] });
        expect(sent.encrypted).toBe(true);
        expect(messagePuts(http).length).toBe(0);
        expect(encrypt.sent.length).toBe(1);

        // What the media repository got is not the file: same length, different bytes.
        expect(http.uploads.length).toBe(1);
        const ciphertext = http.uploads[0];
        const plainBytes = readFileSync(file);
        expect(ciphertext.length).toBe(plainBytes.length);
        expect(Array.from(ciphertext).join() === Array.from(plainBytes).join()).toBe(false);
        // And the upload announces no type: the real one stays inside the encrypted event.
        const upload = http.calls.find((c) => c.method === 'POST')!;
        expect(upload.url.includes('filename=secret.txt')).toBe(true);

        // The event points at the ciphertext with a `file` object and has no `url` field at all.
        const content = encrypt.sent[0].content;
        expect('url' in content).toBe(false);
        const parsed = parseEncryptedFile(content.file);
        expect(parsed !== null).toBe(true);
        expect(parsed!.url).toBe('mxc://example.org/up1');
        expect(parsed!.v).toBe('v2');
        expect(parsed!.key.alg).toBe('A256CTR');
        // The key in the event decrypts exactly those bytes — hash check included.
        const back = await decryptAttachment(ciphertext, parsed!);
        expect(new TextDecoder().decode(back)).toBe(plaintext);
        // The echo keeps the key, so the window can open the file it just sent.
        const handle = sent.echoAttachments?.[0].handle;
        expect(parseAttachmentHandle(handle!)?.file?.key.k).toBe(parsed!.key.k);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('tampered ciphertext is an error, not a decryption attempt', async () => {
      const { ciphertext, file } = await encryptAttachment(new TextEncoder().encode('hello'));
      const flipped = Uint8Array.from(ciphertext);
      flipped[0] ^= 0xff;
      const full = { ...file, url: 'mxc://example.org/x' };
      const reason = await reasonOf(decryptAttachment(flipped, full));
      expect(reason.includes('does not match the hash')).toBe(true);
      // The untouched bytes still come back, so the check is not refusing everything.
      expect(new TextDecoder().decode(await decryptAttachment(ciphertext, full))).toBe('hello');
    });

    await it('the send window is the only way an encrypted event reaches the live fetch', async () => {
      const seen: string[] = [];
      const inner = (async (input: string | URL | Request) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ event_id: '$e:example.org' }), { status: 200 });
      }) as typeof globalThis.fetch;
      const windows = new MatrixSendWindows();
      const live = liveFetch(inner, windows);
      const put = (roomId: string): Promise<Response> =>
        live(`${HS}/rooms/${encodeRoom(roomId)}/send/m.room.encrypted/t1`, { method: 'PUT' });

      // No window: the live client is read-only to the byte, as it was before ADR 0019.
      const before = refusals.length;
      expect(await refused(put(ROOM))).toBe(true);
      expect(seen.length).toBe(0);

      const close = windows.openFor([ROOM]);
      expect((await put(ROOM)).ok).toBe(true);
      expect(seen.length).toBe(1);
      // Only the permit's rooms, and only this one endpoint.
      expect(await refused(put(OTHER))).toBe(true);
      expect(seen.length).toBe(1);

      close();
      expect(await refused(put(ROOM))).toBe(true);
      expect(seen.length).toBe(1);
      // No refused encrypted send landed in the read-only ledger: that one is the sync's own
      // proof it was never asked to write, and a failed send must not fail a sync beside it.
      expect(refusals.length).toBe(before);

      // A cleartext message is a different matter: the window does not cover that endpoint at
      // all, so it falls to the read-only gate — refused, and written into the ledger as such.
      expect(
        await refused(live(`${HS}/rooms/${encodeRoom(ROOM)}/send/m.room.message/t1`, { method: 'PUT' })),
      ).toBe(true);
      expect(seen.length).toBe(1);
      expect(refusals.length).toBe(before + 1);
      // A GET still passes, untouched by any of this.
      expect((await live(`${HS}/rooms/${encodeRoom(ROOM)}/messages`)).ok).toBe(true);
    });

    await it('a window covers what it was opened for, and several may be open', async () => {
      const windows = new MatrixSendWindows();
      expect(windows.refusalFor(ROOM) !== null).toBe(true);
      const closeA = windows.openFor([ROOM]);
      const closeB = windows.openFor([OTHER]);
      expect(windows.refusalFor(ROOM)).toBe(null);
      expect(windows.refusalFor(OTHER)).toBe(null);
      expect(windows.refusalFor('!third:example.org') !== null).toBe(true);
      closeA();
      expect(windows.refusalFor(ROOM) !== null).toBe(true);
      expect(windows.refusalFor(OTHER)).toBe(null);
      closeB();
      closeB();
      expect(windows.refusalFor(OTHER) !== null).toBe(true);
      // The room ids an encrypted PUT names, and nothing else on the client's fetch.
      expect(encryptedSendRoom('PUT', `${HS}/rooms/${encodeRoom(ROOM)}/send/m.room.encrypted/t1`)).toBe(ROOM);
      expect(encryptedSendRoom('PUT', `${HS}/rooms/${encodeRoom(ROOM)}/send/m.room.message/t1`)).toBe(null);
      expect(encryptedSendRoom('GET', `${HS}/rooms/${encodeRoom(ROOM)}/messages`)).toBe(null);
      expect(encryptedSendRoom('PUT', 'not a url')).toBe(null);
    });
  });
};
