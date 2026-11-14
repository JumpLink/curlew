import { describe, expect, it } from '@gjsify/unit';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMessage } from '@curlew/smtp';
import { XMPP_MANIFEST, type XmppBackend } from '@curlew/xmpp';

import { sendAsAgent, sendMessage } from '../../../src/core/actions/send.ts';

import { accountSetDeltaChat, deltaChatEnabled } from '../../../src/core/actions/accounts.ts';
import { defaultConfig, loadConfig, parseConfig, saveConfig } from '../../../src/core/config.ts';
import { composeMailReply } from '../../../src/window/conversation-model.ts';

const raw = async (deltaChat: boolean): Promise<string> => {
  const reply = composeMailReply(null, null, 'Hallo', deltaChat);
  const bytes = await buildMessage({
    from: 'me@example.org',
    to: ['you@example.org'],
    subject: reply.subject,
    text: 'Hallo',
    ...(reply.emailChat ? { emailChat: true } : {}),
  });
  return new TextDecoder().decode(bytes);
};

export default async () => {
  await describe('Delta Chat opt-in per mail account', async () => {
    await it('is off for a config without the field and for a fresh account', async () => {
      expect(parseConfig('{}').mailAccounts).toBe(undefined);
      expect(defaultConfig().mailAccounts).toBe(undefined);
    });

    await it('stores the choice per account and leaves the others alone', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-dc-'));
      try {
        const path = join(dir, 'config.json');
        saveConfig(defaultConfig(), path);
        expect(readFileSync(path, 'utf8').includes('mailAccounts')).toBe(false);
        accountSetDeltaChat('mail-1', true, path);
        accountSetDeltaChat('mail-1', true, path);
        expect(deltaChatEnabled('mail-1', path)).toBe(true);
        expect(deltaChatEnabled('mail-2', path)).toBe(false);
        expect(Object.keys(loadConfig(path).mailAccounts ?? {}).join(',')).toBe('mail-1');
        accountSetDeltaChat('mail-1', false, path);
        expect(deltaChatEnabled('mail-1', path)).toBe(false);
        expect(readFileSync(path, 'utf8').includes('mailAccounts')).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('rejects a malformed list', async () => {
      expect(() => parseConfig('{"deltaChatAccounts":"mail-1"}')).toThrow(/deltaChatAccounts/);
      expect(() => parseConfig('{"deltaChatAccounts":[""]}')).toThrow(/deltaChatAccounts/);
      expect(() => parseConfig('{"mailAccounts":{"a":{"plainMail":"no"}}}')).toThrow(/mailAccounts/);
      expect(() => parseConfig('{"mailAccounts":[]}')).toThrow(/mailAccounts/);
    });

    await it('puts Chat-Version on the wire only with the opt-in', async () => {
      expect((await raw(false)).includes('Chat-Version')).toBe(false);
      expect((await raw(true)).includes('Chat-Version: 1.0')).toBe(true);
    });

    await it('refuses an email chat send from an account that is not opted in, and sends once it is', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-dc-send-'));
      try {
        let opened = 0;
        const backend = {
          manifest: {
            ...XMPP_MANIFEST,
            name: 'mail',
            capabilities: { ...XMPP_MANIFEST.capabilities, subject: true },
          },
          listAccounts: async () => [{ id: 'mail-1', identity: 'me@example.org', provider: 'mail' }],
          isSelfAddress: async () => false,
          openSender: async () => {
            opened += 1;
            throw new Error('sender reached');
          },
        } as unknown as XmppBackend;
        const call = (configPath: string, emailChat: boolean) =>
          sendMessage({
            accountId: 'mail-1',
            to: 'you@example.org',
            text: 'Hallo',
            ...(emailChat ? { emailChat: true } : {}),
            frontend: 'cli',
            dbPath: join(dir, 'index.db'),
            configPath,
            writeLogPath: join(dir, 'write.log'),
            backend,
          });
        const off = join(dir, 'off.json');
        writeFileSync(off, '{}');
        await expect(call(off, true)).rejects.toThrow(/not opted into Delta Chat.*Use for Delta Chat/);
        expect(opened).toBe(0);
        expect(existsSync(join(dir, 'write.log'))).toBe(false);
        await expect(call(off, false)).rejects.toThrow(/sender reached/);
        const on = join(dir, 'on.json');
        writeFileSync(on, JSON.stringify({ mailAccounts: { 'mail-1': { deltaChat: true } } }));
        await expect(call(on, true)).rejects.toThrow(/sender reached/);
        expect(opened).toBe(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('names the AI switch when the CLI is refused with AI off', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-ai-off-'));
      try {
        const configPath = join(dir, 'config.json');
        writeFileSync(configPath, JSON.stringify({ ui: { ai: false } }));
        const backend = {
          manifest: { ...XMPP_MANIFEST, name: 'mail' },
          listAccounts: async () => [{ id: 'mail-1', identity: 'me@example.org', provider: 'mail' }],
          isSelfAddress: async () => false,
          openSender: async () => {
            throw new Error('sender reached');
          },
        } as unknown as XmppBackend;
        await expect(
          sendAsAgent({
            accountId: 'mail-1',
            to: 'you@example.org',
            text: 'Hallo',
            frontend: 'cli',
            dbPath: join(dir, 'index.db'),
            configPath,
            writeLogPath: join(dir, 'write.log'),
            backend,
          }),
        ).rejects.toThrow(/AI access is off: switch it on in Preferences → AI \(or set ui\.ai to true/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
