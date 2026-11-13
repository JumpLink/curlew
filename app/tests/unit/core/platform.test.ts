import { describe, expect, it } from '@gjsify/unit';

import { builtinRegistry } from '../../../src/core/backends/builtin.ts';
import { backendAvailable, chatOnly } from '../../../src/core/platform.ts';
import { buildProtocolGroups, type AccountsLoadState } from '../../../src/window/accounts-model.ts';

const load = {
  backends: [],
  goaAccounts: { accounts: [] },
  ownMailAccounts: [],
  chatAccounts: [],
  labels: new Map(),
} as unknown as AccountsLoadState;

export default async () => {
  describe('the platform predicate', () => {
    it('is chat only on Windows and macOS, never on Linux', () => {
      expect(chatOnly('win32')).toBe(true);
      expect(chatOnly('darwin')).toBe(true);
      expect(chatOnly('linux')).toBe(false);
    });

    it('drops mail and keeps every chat protocol on a chat-only platform', () => {
      expect(backendAvailable('mail', 'win32')).toBe(false);
      expect(backendAvailable('xmpp', 'win32')).toBe(true);
      expect(backendAvailable('mail', 'linux')).toBe(true);
      expect(builtinRegistry('darwin').names().includes('mail')).toBe(false);
      expect(builtinRegistry('darwin').names().includes('signal')).toBe(true);
      expect(builtinRegistry('linux').names().includes('mail')).toBe(true);
    });

    it('lists no mail group on a chat-only platform', () => {
      const daemon = { present: true, accounts: new Map() };
      expect(buildProtocolGroups(load, daemon, 'win32').groups.length).toBe(0);
      expect(buildProtocolGroups(load, daemon, 'linux').groups[0]?.backend).toBe('mail');
    });
  });
};
