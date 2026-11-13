import { describe, expect, it } from '@gjsify/unit';
import type { BackendCapabilities } from '@curlew/protocol';

import { defaultConfig } from '../../../src/core/config.ts';
import type { BackendStatus } from '../../../src/core/backends/registry.ts';
import {
  applyDeltaChatAccounts,
  deltaChatRow,
  deltaChatSubtitle,
} from '../../../src/window/account-add-model.ts';

const status = (name: string, enabled: boolean): BackendStatus => ({
  name,
  displayName: name,
  enabled,
  syncModel: 'server-archive',
  storeTier: 'derived',
  native: false,
  capabilities: {} as BackendCapabilities,
  terms: null,
  termsAccepted: false,
});

export default async () => {
  await describe('the derived Delta Chat row', async () => {
    await it('is off while no mail account is opted in', async () => {
      const row = deltaChatRow([status('mail', true)], defaultConfig());
      expect(row.enabled).toBe(false);
      expect(row.available).toBe(true);
    });

    await it('is on with a count once an account is opted in', async () => {
      const row = deltaChatRow([status('mail', true)], {
        mailAccounts: { a: { deltaChat: true }, b: { deltaChat: true } },
      });
      expect(row.enabled).toBe(true);
      expect(row.count).toBe(2);
      expect(deltaChatSubtitle(row)).toBe('2 accounts');
    });

    await it('is greyed with a reason while mail is off', async () => {
      const row = deltaChatRow([status('mail', false)], { mailAccounts: { a: { deltaChat: true } } });
      expect(row.available).toBe(false);
      expect(row.enabled).toBe(false);
      expect(deltaChatSubtitle(row).includes('Mail')).toBe(true);
    });

    await it('opts exactly the chosen accounts in and the rest out', async () => {
      const config = { ...defaultConfig(), mailAccounts: { a: { deltaChat: true } } };
      applyDeltaChatAccounts(config, ['a', 'b'], new Set(['b']));
      expect(config.mailAccounts).toStrictEqual({ b: { deltaChat: true } });
    });
  });
};
