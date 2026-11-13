import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { accountSetEncryptionRequired, encryptionRequiredFor } from '../../../src/core/actions/accounts.ts';
import { loadConfig, parseConfig, saveConfig } from '../../../src/core/config.ts';
import { CONFIG_SETTINGS, UI_SETTINGS } from '../../../src/window/settings-map.ts';

const FULL = {
  ui: {
    showAllEmails: false,
    notifications: 'sender',
    playVideosSilently: true,
    sendReadReceipts: true,
    accentColor: 'teal',
    primaryColor: 'blue',
    colorScheme: 'dark',
    chatBackground: 'none',
    welcomeDone: true,
    ai: true,
    emailChatHintSeen: ['mail-a'],
    searchScope: 'names',
  },
  deltaChatAccounts: ['mail-a'],
};

export default async () => {
  await describe('settings map', async () => {
    await it('names a place for every ui key parseConfig keeps', async () => {
      const keys = Object.keys(parseConfig(JSON.stringify(FULL)).ui).sort();
      expect(keys).toStrictEqual(Object.keys(UI_SETTINGS).sort());
    });

    await it('keeps read receipts off unless set, and refuses a non-boolean', async () => {
      expect(parseConfig('{}').ui.sendReadReceipts).toBe(undefined);
      expect(parseConfig('{"ui":{"sendReadReceipts":true}}').ui.sendReadReceipts).toBe(true);
      expect(() => parseConfig('{"ui":{"sendReadReceipts":"yes"}}')).toThrow(/sendReadReceipts/);
    });

    await it('names a place for every top-level key parseConfig returns', async () => {
      const keys = Object.keys(parseConfig(JSON.stringify(FULL))).sort();
      expect(keys).toStrictEqual(Object.keys(CONFIG_SETTINGS).sort());
    });

    await it('requires encryption per account and keeps single-peer entries', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-settings-'));
      try {
        const path = join(dir, 'config.json');
        const config = parseConfig('{}');
        config.encryption = { 'xmpp-a/p@example.org': 'required' };
        saveConfig(config, path);
        expect(encryptionRequiredFor('xmpp-a', path)).toBe(false);
        accountSetEncryptionRequired('xmpp-a', true, path);
        expect(encryptionRequiredFor('xmpp-a', path)).toBe(true);
        accountSetEncryptionRequired('xmpp-a', false, path);
        expect(encryptionRequiredFor('xmpp-a', path)).toBe(false);
        expect(Object.keys(loadConfig(path).encryption)).toStrictEqual(['xmpp-a/p@example.org']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
