import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountPrompter, BackendContext, SendPermit } from '@curlew/protocol';
import { ChatPinLimitError, isSendBackend } from '@curlew/protocol';
import { chatConversationId, getConversation } from '@curlew/store';
import {
  MUTE_FOREVER,
  TELEGRAM_MAX_CAPTION_CHARS,
  TELEGRAM_MAX_MESSAGE_CHARS,
  TELEGRAM_MANIFEST,
  TelegramBackend,
} from '@curlew/telegram';

import { openIndex } from '../../../src/core/actions/index.ts';
import { sendAsAgent, sendMessage } from '../../../src/core/actions/send.ts';
import { fakeFactory } from './fake-client.ts';

// Synthetic only: a fake client, a temporary directory per case, no session of anyone's.
const ACCOUNT = 'telegram-42';
const BEN = 1002;
const granted = { grants: [{ capability: 'telegram.send', target: `${ACCOUNT}/1001` }] };

interface Rig {
  dir: string;
  configPath: string;
  backend: TelegramBackend;
  fake: ReturnType<typeof fakeFactory>;
}

function prompter(): AccountPrompter {
  const queue = ['+49 170 0000000', '12345', 'correct horse'];
  return { ask: async () => queue.shift() ?? '', notify: () => {} };
}

/** A temporary directory with a config, a logged-in fake session file and a backend over it. */
async function withRig<T>(config: unknown, body: (rig: Rig) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-telegram-send-'));
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));
    const context: BackendContext = {
      settings: {},
      env: { CURLEW_TELEGRAM_API_ID: '12345', CURLEW_TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef' },
      secretsDir: join(dir, 'secrets', 'telegram'),
    };
    const fake = fakeFactory({ dialogs: [] });
    const backend = new TelegramBackend(context, fake.create);
    await backend.addAccount(prompter());
    fake.clients.length = 0;
    return await body({ dir, configPath, backend, fake });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const send = (rig: Rig, to: string, text: string) =>
  sendAsAgent({
    accountId: ACCOUNT,
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

export default async () => {
  await describe('Telegram sending', async () => {
    await it('is a send backend that can attach files', async () => {
      await withRig(granted, async ({ backend }) => {
        expect(isSendBackend(backend)).toBe(true);
        expect(TELEGRAM_MANIFEST.name).toBe('telegram');
        const sender = await backend.openSender(ACCOUNT, { account: ACCOUNT, addresses: ['1001'] });
        expect(sender.features.markdown).toBe(false);
        expect(sender.features.attachments).toBe(true);
        expect(sender.sendImage === undefined).toBe(true);
        await sender.close();
      });
    });

    await it('refuses without a grant, before the session is even opened', async () => {
      for (const config of [{ grants: [] }]) {
        await withRig(config, async (rig) => {
          expect(await refused(send(rig, '1001', 'Hallo'))).toBe(true);
          expect(rig.fake.clients.length).toBe(0);
        });
      }
    });

    await it('refuses a chat the grant does not name — in the action and in the sender', async () => {
      await withRig(granted, async (rig) => {
        expect(await refused(send(rig, String(BEN), 'Hallo'))).toBe(true);
        expect(rig.fake.clients.length).toBe(0);

        const permit: SendPermit = { account: ACCOUNT, addresses: ['1001'] };
        const sender = await rig.backend.openSender(ACCOUNT, permit);
        expect(await refused(sender.send({ to: String(BEN), text: 'Hallo' }))).toBe(true);
        expect(await refused(sender.send({ to: 'not-a-number', text: 'Hallo' }))).toBe(true);
        expect(rig.fake.clients[0].sent.length).toBe(0);
        await sender.close();
      });
    });

    await it('sends once, logs telegram.send without the text, and indexes the outgoing message', async () => {
      await withRig(granted, async (rig) => {
        const out = await send(rig, '1001', 'Hallo Anna');
        expect(out.backend).toBe('telegram');
        expect(out.target).toBe(`${ACCOUNT}/1001`);
        const client = rig.fake.clients[0];
        expect(client.sent.length).toBe(1);
        expect(client.sent[0].chatId).toBe(1001);
        expect(client.sent[0].text).toBe('Hallo Anna');
        expect(client.destroyed).toBe(1);

        const line = JSON.parse(readFileSync(join(rig.dir, 'writes.log'), 'utf8').trim());
        expect(line.capability).toBe('telegram.send');
        expect(line.target).toBe(`${ACCOUNT}/1001`);
        expect(line.id).toBe(out.originId);
        expect(line.text === undefined).toBe(true);

        const db = openIndex(join(rig.dir, 'index.db'));
        try {
          const conversation = getConversation(db, chatConversationId('telegram', ACCOUNT, '1001'), {
            includeBodies: true,
          });
          expect(conversation?.messages.length).toBe(1);
          expect(conversation?.messages[0].fromSelf).toBe(true);
        } finally {
          db.close();
        }
      });
    });

    await it('sends to a group by its negative marked chat id, end to end', async () => {
      const group = '-1001234567';
      await withRig(
        { grants: [{ capability: 'telegram.send', target: `${ACCOUNT}/${group}` }] },
        async (rig) => {
          const out = await send(rig, group, 'Hallo Gruppe');
          expect(out.target).toBe(`${ACCOUNT}/${group}`);
          expect(rig.fake.clients[0].sent.length).toBe(1);
          expect(rig.fake.clients[0].sent[0].chatId).toBe(-1001234567);
        },
      );
    });

    await it('refuses text over 4096 characters instead of splitting it', async () => {
      await withRig(granted, async (rig) => {
        expect(await refused(send(rig, '1001', 'x'.repeat(TELEGRAM_MAX_MESSAGE_CHARS + 1)))).toBe(true);
        expect(rig.fake.clients[0].sent.length).toBe(0);
        const ok = await send(rig, '1001', 'x'.repeat(TELEGRAM_MAX_MESSAGE_CHARS));
        expect(ok.backend).toBe('telegram');
        expect(rig.fake.clients[1].sent.length).toBe(1);
      });
    });

    await it('answers a message of the same chat, on the text and on the first file only', async () => {
      await withRig(granted, async (rig) => {
        const permit: SendPermit = { account: ACCOUNT, addresses: ['1001'] };
        const sender = await rig.backend.openSender(ACCOUNT, permit);
        expect(sender.features.replies).toBe(true);
        await sender.send({ to: '1001', text: 'Gern', replyTo: { remoteId: '1001/7' } });
        await sender.send({ to: '1001', text: 'Ohne' });
        const photo = join(rig.dir, 'cat.png');
        writeFileSync(photo, new Uint8Array([1, 2, 3, 4]));
        const other = join(rig.dir, 'dog.png');
        writeFileSync(other, new Uint8Array([5, 6, 7, 8]));
        await sender.send({
          to: '1001',
          text: '',
          replyTo: { remoteId: '1001/7' },
          attachments: [{ path: photo }, { path: other }],
        });
        const client = rig.fake.clients[0];
        expect(client.sent[0].replyTo).toBe(7);
        expect(client.sent[1].replyTo === undefined).toBe(true);
        expect(client.files[0].replyTo).toBe(7);
        expect(client.files[1].replyTo === undefined).toBe(true);
        await sender.close();
      });
    });

    await it('mutes and unmutes a chat of the grant, with an end or without', async () => {
      await withRig(granted, async (rig) => {
        const sender = await rig.backend.openSender(ACCOUNT, { account: ACCOUNT, addresses: ['1001'] });
        expect(sender.features.chatFlags).toBe(true);
        expect(rig.backend.manifest.capabilities?.mutes).toBe(true);
        await sender.setChatFlags?.({ to: '1001', mute: { muted: true, until: null } });
        await sender.setChatFlags?.({ to: '1001', mute: { muted: true, until: '2026-12-01T00:00:00.000Z' } });
        await sender.setChatFlags?.({ to: '1001', mute: { muted: false, until: null } });
        await sender.setChatFlags?.({ to: '1001', favourite: true });
        const muted = rig.fake.clients[0].muted;
        expect(muted.length).toBe(3);
        expect(muted[0].until).toBe(MUTE_FOREVER);
        expect(muted[1].until).toBe(Date.parse('2026-12-01T00:00:00.000Z') / 1000);
        expect(muted[2].until).toBe(0);
        expect(
          await refused(
            sender.setChatFlags?.({ to: '2002', mute: { muted: true, until: null } }) ?? Promise.resolve(),
          ),
        ).toBe(true);
        await sender.close();
      });
    });

    await it('pins a chat of the grant, and refuses a pin beyond the limit without unpinning another', async () => {
      await withRig(granted, async (rig) => {
        const sender = await rig.backend.openSender(ACCOUNT, { account: ACCOUNT, addresses: ['1001'] });
        expect(rig.backend.manifest.capabilities?.pins).toBe(true);
        await sender.setChatFlags?.({ to: '1001', favourite: true });
        await sender.setChatFlags?.({ to: '1001', favourite: false });
        const client = rig.fake.clients[0];
        expect(client.pins.map((p) => p.pinned)).toEqualArray([true, false]);
        client.pinSlotsReply = { pinned: 5, limit: 5 };
        let limit: number | null = null;
        try {
          await sender.setChatFlags?.({ to: '1001', favourite: true });
        } catch (error) {
          limit = error instanceof ChatPinLimitError ? error.limit : -1;
        }
        expect(limit).toBe(5);
        expect(client.pins.length).toBe(2);
        await sender.close();
      });
    });

    await it('edits and deletes the persons own message, and nothing else', async () => {
      await withRig(granted, async (rig) => {
        const sender = await rig.backend.openSender(ACCOUNT, { account: ACCOUNT, addresses: ['1001'] });
        expect(sender.features.edits).toBe(true);
        expect(sender.features.deletes).toBe(true);
        const mine = { remoteId: '1001/7', fromSelf: true };
        await sender.edit!({ to: '1001', target: mine, text: 'Fixed' });
        await sender.delete!({ to: '1001', target: mine });
        const client = rig.fake.clients[0];
        expect(client.edited).toStrictEqual([{ chatId: 1001, messageId: 7, text: 'Fixed' }]);
        expect(client.deleted).toStrictEqual([{ chatId: 1001, messageId: 7 }]);
        for (const attempt of [
          sender.edit!({ to: '1001', target: { remoteId: '1001/7', fromSelf: false }, text: 'x' }),
          sender.delete!({ to: '1001', target: { remoteId: '1001/7' } }),
          sender.edit!({ to: '1001', target: { remoteId: '1002/7', fromSelf: true }, text: 'x' }),
          sender.delete!({ to: '1002', target: { remoteId: '1002/7', fromSelf: true } }),
          sender.edit!({ to: '1001', target: mine, text: 'x'.repeat(4097) }),
        ]) {
          expect(await refused(attempt)).toBe(true);
        }
        expect(client.edited.length).toBe(1);
        expect(client.deleted.length).toBe(1);
        await sender.close();
      });
    });

    await it('reacts to a message of the chat, without the variation selector, and takes it back', async () => {
      await withRig(granted, async (rig) => {
        const sender = await rig.backend.openSender(ACCOUNT, { account: ACCOUNT, addresses: ['1001'] });
        expect(sender.features.reactions).toBe(true);
        await sender.react!({ to: '1001', target: { remoteId: '1001/7' }, emoji: '❤️' });
        await sender.react!({ to: '1001', target: { remoteId: '1001/7' }, emoji: null, previous: '❤️' });
        expect(rig.fake.clients[0].reactions).toStrictEqual([
          { chatId: 1001, messageId: 7, emoji: '❤' },
          { chatId: 1001, messageId: 7, emoji: null },
        ]);
        for (const [to, remoteId] of [
          ['1001', '1002/7'],
          ['1002', '1002/7'],
        ]) {
          expect(await refused(sender.react!({ to, target: { remoteId }, emoji: '👍' }))).toBe(true);
        }
        expect(rig.fake.clients[0].reactions.length).toBe(2);
        await sender.close();
      });
    });

    await it('says why Telegram refuses a reaction, and passes other errors on', async () => {
      await withRig(granted, async (rig) => {
        const sender = await rig.backend.openSender(ACCOUNT, { account: ACCOUNT, addresses: ['1001'] });
        const react = () => sender.react!({ to: '1001', target: { remoteId: '1001/7' }, emoji: '❤️' });
        const failure = async (): Promise<string> => {
          try {
            await react();
          } catch (err) {
            return (err as Error).message;
          }
          return '';
        };
        const client = rig.fake.clients[0];
        client.reactionError = 'PREMIUM_ACCOUNT_REQUIRED';
        expect((await failure()).includes('Premium')).toBe(true);
        client.reactionError = 'REACTION_INVALID';
        expect((await failure()).includes('does not allow')).toBe(true);
        client.reactionError = 'SOMETHING_ELSE';
        expect(await failure()).toBe('rpc');
        await sender.close();
      });
    });

    await it('refuses a reply to a message of another chat or of no chat', async () => {
      await withRig(granted, async (rig) => {
        const sender = await rig.backend.openSender(ACCOUNT, { account: ACCOUNT, addresses: ['1001'] });
        for (const remoteId of ['1002/7', '7', 'x/7']) {
          expect(await refused(sender.send({ to: '1001', text: 'Hi', replyTo: { remoteId } }))).toBe(true);
        }
        expect(rig.fake.clients[0].sent.length).toBe(0);
        await sender.close();
      });
    });

    await it('sends a picked file from the window: a photo with the text as its caption', async () => {
      await withRig({}, async (rig) => {
        const photo = join(rig.dir, 'cat.png');
        writeFileSync(photo, new Uint8Array([1, 2, 3, 4]));
        const out = await sendMessage({
          accountId: ACCOUNT,
          to: '1001',
          text: 'Look',
          attachments: [photo],
          frontend: 'window',
          dbPath: join(rig.dir, 'index.db'),
          configPath: rig.configPath,
          writeLogPath: join(rig.dir, 'writes.log'),
          backend: rig.backend,
        });
        const client = rig.fake.clients[0];
        expect(client.files.length).toBe(1);
        expect(client.files[0].fileName).toBe('cat.png');
        expect(client.files[0].size).toBe(4);
        expect(client.files[0].asPhoto).toBe(true);
        expect(client.files[0].caption).toBe('Look');
        expect(client.sent.length).toBe(0);
        expect(out.attachments?.[0]?.filename).toBe('cat.png');
        // The log names the file and its size, never its bytes.
        const line = JSON.parse(readFileSync(join(rig.dir, 'writes.log'), 'utf8').trim());
        expect(line.attachments[0].filename).toBe('cat.png');
        expect(line.attachments[0].size).toBe(4);
      });
    });

    await it('sends a file without text as a document, and a long text after the file', async () => {
      await withRig({}, async (rig) => {
        const doc = join(rig.dir, 'notes.pdf');
        writeFileSync(doc, new Uint8Array(10));
        const base = {
          accountId: ACCOUNT,
          to: '1001',
          attachments: [doc],
          frontend: 'window' as const,
          dbPath: join(rig.dir, 'index.db'),
          configPath: rig.configPath,
          writeLogPath: join(rig.dir, 'writes.log'),
          backend: rig.backend,
        };
        await sendMessage(base);
        const first = rig.fake.clients[0];
        expect(first.files[0].asPhoto).toBe(false);
        expect(first.files[0].caption === undefined).toBe(true);
        expect(first.sent.length).toBe(0);

        await sendMessage({ ...base, text: 'x'.repeat(TELEGRAM_MAX_CAPTION_CHARS + 1) });
        const second = rig.fake.clients[1];
        expect(second.files[0].caption === undefined).toBe(true);
        expect(second.sent.length).toBe(1);
        expect(second.calls.indexOf('sendFile:1001') < second.calls.indexOf('sendText:1001')).toBe(true);
      });
    });

    await it('sends video, audio and an Ogg Opus mono voice note as what they are', async () => {
      await withRig({}, async (rig) => {
        const ogg = (channels: number) => {
          const page = (granule: number, segments: number[], body: number[]) => {
            const h = new Uint8Array(27 + segments.length + body.length);
            h.set([0x4f, 0x67, 0x67, 0x53, 0, 0]);
            new DataView(h.buffer).setUint32(6, granule, true);
            h[26] = segments.length;
            h.set(segments, 27);
            h.set(body, 27 + segments.length);
            return h;
          };
          const head = [...'OpusHead']
            .map((c) => c.charCodeAt(0))
            .concat([1, channels, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0]);
          const first = page(0, [head.length], head);
          const last = page(96000, [], []);
          const out = new Uint8Array(first.length + last.length);
          out.set(first);
          out.set(last, first.length);
          return out;
        };
        const files: Record<string, Uint8Array> = {
          'clip.mp4': new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4]),
          'song.mp3': new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0]),
          'note.ogg': ogg(1),
          'music.ogg': ogg(2),
        };
        const paths = Object.entries(files).map(([name, bytes]) => {
          const p = join(rig.dir, name);
          writeFileSync(p, bytes);
          return p;
        });
        const out = await sendMessage({
          accountId: ACCOUNT,
          to: '1001',
          attachments: paths,
          frontend: 'window',
          dbPath: join(rig.dir, 'index.db'),
          configPath: rig.configPath,
          writeLogPath: join(rig.dir, 'writes.log'),
          backend: rig.backend,
        });
        const sent = rig.fake.clients[0].files;
        const by = (name: string) => sent.find((f) => f.fileName === name)!;
        expect(by('clip.mp4').as).toBe('video');
        expect(by('clip.mp4').asPhoto).toBe(false);
        expect(by('song.mp3').as).toBe('audio');
        expect(by('note.ogg').as).toBe('voice');
        expect(by('note.ogg').duration).toBe(2);
        expect(by('music.ogg').as).toBe('audio');
        // The sent messages come back as attachments, so the window shows them at once.
        expect(out.attachments?.length).toBe(4);
      });
    });

    await it('echoes a sent photo as a received attachment, with its own handle', async () => {
      await withRig({}, async (rig) => {
        const photo = join(rig.dir, 'cat.png');
        writeFileSync(photo, new Uint8Array([1, 2, 3, 4]));
        const sender = await rig.backend.openSender(ACCOUNT, { account: ACCOUNT, addresses: ['1001'] });
        const sent = await sender.send({ to: '1001', text: 'x', attachments: [{ path: photo }] });
        const echo = sent.echoAttachments ?? [];
        expect(echo.length).toBe(1);
        expect(echo[0].kind).toBe('image');
        expect(typeof echo[0].handle).toBe('string');
        await sender.close();
      });
    });

    await it('refuses a bad file before a byte is sent', async () => {
      await withRig({}, async (rig) => {
        const base = {
          accountId: ACCOUNT,
          to: '1001',
          text: 'x',
          frontend: 'window' as const,
          dbPath: join(rig.dir, 'index.db'),
          configPath: rig.configPath,
          writeLogPath: join(rig.dir, 'writes.log'),
          backend: rig.backend,
        };
        expect(await refused(sendMessage({ ...base, attachments: ['relative.png'] }))).toBe(true);
        expect(await refused(sendMessage({ ...base, attachments: [join(rig.dir, 'missing.png')] }))).toBe(
          true,
        );
        expect(await refused(sendMessage({ ...base, attachments: [rig.dir] }))).toBe(true);
        for (const client of rig.fake.clients) {
          expect(client.files.length).toBe(0);
          expect(client.sent.length).toBe(0);
        }
      });
    });

    await it('takes no attachment from an agent, even with a grant', async () => {
      await withRig(granted, async (rig) => {
        const file = join(rig.dir, 'secret.txt');
        writeFileSync(file, 'x');
        const attempt = sendAsAgent({
          accountId: ACCOUNT,
          to: '1001',
          text: 'x',
          attachments: [file],
          frontend: 'cli',
          dbPath: join(rig.dir, 'index.db'),
          configPath: rig.configPath,
          writeLogPath: join(rig.dir, 'writes.log'),
          backend: rig.backend,
        });
        expect(await refused(attempt)).toBe(true);
        expect(rig.fake.clients.length).toBe(0);
      });
    });

    await it('keeps the read session unable to send', async () => {
      await withRig(granted, async ({ backend, fake }) => {
        const session = await backend.connect(ACCOUNT);
        expect('sendText' in session).toBe(false);
        expect('sendFile' in session).toBe(false);
        expect('send' in session).toBe(false);
        expect('sendText' in (session as unknown as { api: object }).api).toBe(false);
        expect('sendFile' in (session as unknown as { api: object }).api).toBe(false);
        expect(fake.clients[0].sent.length).toBe(0);
        await session.close();
      });
    });
  });
};
