import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMessage } from '@curlew/smtp';

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
  });
};
