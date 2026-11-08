import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BackendAccount, visibleAccounts } from '@curlew/protocol';
import { SecretStore } from '@curlew/store';
import { TelegramBackend } from '@curlew/telegram';

import { accountSetEnabled } from '../../../src/core/actions/accounts.ts';
import { backendContext } from '../../../src/core/backends/context.ts';
import { defaultConfig, loadConfig, parseConfig, saveConfig } from '../../../src/core/config.ts';
import { buildProtocolGroups } from '../../../src/window/accounts-model.ts';

function account(id: string): BackendAccount {
  return { id, identity: id, provider: 'Test' };
}

export default async () => {
  await describe('switching an account off', async () => {
    await it('leaves a switched-off account out of a listing, and marks it when asked', async () => {
      const all = [account('a'), account('b')];
      const context = { disabledAccounts: ['b'] };
      expect(
        visibleAccounts(context, all)
          .map((a) => a.id)
          .join(','),
      ).toBe('a');
      const shown = visibleAccounts(context, all, { includeDisabled: true });
      expect(shown.map((a) => `${a.id}:${a.disabled === true}`).join(',')).toBe('a:false,b:true');
      expect(visibleAccounts({}, all).length).toBe(2);
    });

    await it('keeps the choice in the config file and nowhere else', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-toggle-'));
      try {
        const path = join(dir, 'config.json');
        saveConfig(defaultConfig(), path);
        accountSetEnabled('telegram', 'telegram-1', false, path);
        accountSetEnabled('telegram', 'telegram-1', false, path);
        accountSetEnabled('xmpp', 'xmpp-a', false, path);
        expect(loadConfig(path).disabledAccounts.join(',')).toBe('telegram/telegram-1,xmpp/xmpp-a');
        accountSetEnabled('telegram', 'telegram-1', true, path);
        expect(loadConfig(path).disabledAccounts.join(',')).toBe('xmpp/xmpp-a');
        accountSetEnabled('xmpp', 'xmpp-a', true, path);
        expect(readFileSync(path, 'utf8').includes('disabledAccounts')).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('refuses a malformed list', async () => {
      expect(() => parseConfig('{"disabledAccounts":["no-slash"]}')).toThrow(/disabledAccounts/);
      expect(() => parseConfig('{"disabledAccounts":"telegram/x"}')).toThrow(/disabledAccounts/);
    });

    await it('hands a backend only its own switched-off accounts', async () => {
      const config = defaultConfig();
      config.disabledAccounts = ['telegram/telegram-1', 'xmpp/xmpp-a'];
      expect(backendContext('telegram', config).disabledAccounts?.join(',')).toBe('telegram-1');
      expect(backendContext('matrix', config).disabledAccounts?.length).toBe(0);
    });

    await it('stops a backend listing the account, and lists it again when switched on', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-toggle-'));
      try {
        const store = SecretStore.open(join(dir, 'telegram-1.db'));
        store.close();
        const make = (off: string[]) =>
          new TelegramBackend({ settings: {}, env: {}, secretsDir: dir, disabledAccounts: off });
        expect((await make([]).listAccounts()).length).toBe(1);
        expect((await make(['telegram-1']).listAccounts()).length).toBe(0);
        const shown = await make(['telegram-1']).listAccounts({ includeDisabled: true });
        expect(shown[0]!.disabled).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('shows a switched-off account as off, with or without the daemon', async () => {
      const load = {
        backends: [{ name: 'telegram', enabled: true }],
        goaAccounts: { accounts: [] },
        chatAccounts: [{ backend: 'telegram', accounts: [{ ...account('telegram-1'), disabled: true }] }],
        labels: new Map<string, string>(),
      };
      for (const present of [true, false]) {
        const state = buildProtocolGroups(load as never, { present, accounts: new Map() });
        const group = state.groups.find((g) => g.backend === 'telegram')!;
        expect(group.rows[0]!.status).toBe('disabled');
      }
    });
  });
};
