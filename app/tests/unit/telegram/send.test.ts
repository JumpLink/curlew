import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountPrompter, BackendContext, SendPermit } from '@curlew/protocol';
import { isSendBackend } from '@curlew/protocol';
import { chatConversationId, getConversation } from '@curlew/store';
import {
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
