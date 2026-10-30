import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountPrompter, BackendContext, SendPermit } from '@curlew/protocol';
import { isSendBackend } from '@curlew/protocol';
import { chatConversationId, getConversation } from '@curlew/store';
import { TELEGRAM_MAX_MESSAGE_CHARS, TELEGRAM_MANIFEST, TelegramBackend } from '@curlew/telegram';

import { openIndex } from '../../../src/core/actions/index.ts';
import { sendMessage } from '../../../src/core/actions/send.ts';
import { withSendGateGrants } from '../../../src/frontends/mcp/tools/send.ts';
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
  sendMessage({
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
    await it('is a send backend, plain text only', async () => {
      await withRig(granted, async ({ backend }) => {
        expect(isSendBackend(backend)).toBe(true);
        expect(TELEGRAM_MANIFEST.name).toBe('telegram');
        const sender = await backend.openSender(ACCOUNT, { account: ACCOUNT, addresses: ['1001'] });
        expect(sender.features.markdown).toBe(false);
        expect(sender.sendImage === undefined).toBe(true);
        await sender.close();
      });
    });

    await it('refuses without a grant, before the session is even opened', async () => {
      for (const config of [
        { grants: [] },
        { grants: [{ capability: 'xmpp.send', target: `${ACCOUNT}/1001` }] },
      ]) {
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

    await it('keeps the read session unable to send', async () => {
      await withRig(granted, async ({ backend, fake }) => {
        const session = await backend.connect(ACCOUNT);
        expect('sendText' in session).toBe(false);
        expect('send' in session).toBe(false);
        expect('sendText' in (session as unknown as { api: object }).api).toBe(false);
        expect(fake.clients[0].sent.length).toBe(0);
        await session.close();
      });
    });

    await it('serves send_message to the MCP gate with a telegram.send grant alone', async () => {
      const union = withSendGateGrants([{ capability: 'telegram.send', target: `${ACCOUNT}/1001` }]);
      expect(union.some((g) => g.capability === 'send' && g.target === `${ACCOUNT}/1001`)).toBe(true);
    });
  });
};
