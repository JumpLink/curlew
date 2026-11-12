import { describe, expect, it } from '@gjsify/unit';

import { parseConfig } from '../../../src/core/config.ts';
import type { AccountsLoadState } from '../../../src/window/accounts-model.ts';
import { countAccounts, shouldShowWelcome, welcomePages } from '../../../src/window/welcome-model.ts';

const load = (goa: number, own: number, chat: number): AccountsLoadState =>
  ({
    backends: [],
    goaAccounts: { accounts: Array.from({ length: goa }, () => ({})) },
    ownMailAccounts: Array.from({ length: own }, () => ({})),
    chatAccounts: [{ backend: 'xmpp', accounts: Array.from({ length: chat }, () => ({})) }],
    labels: new Map(),
  }) as unknown as AccountsLoadState;

export default async () => {
  describe('the welcome screen model', () => {
    it('shows on a first start without accounts only', () => {
      expect(shouldShowWelcome(undefined, 0)).toBe(true);
      expect(shouldShowWelcome(false, 0)).toBe(true);
      expect(shouldShowWelcome(true, 0)).toBe(false);
      expect(shouldShowWelcome(undefined, 1)).toBe(false);
    });

    it('counts mail, GNOME and chat accounts', () => {
      expect(countAccounts(load(0, 0, 0))).toBe(0);
      expect(countAccounts(load(1, 2, 3))).toBe(6);
    });

    it('starts with the introduction and ends with accounts', () => {
      expect(welcomePages()).toStrictEqual(['intro', 'accounts']);
    });

    it('reads and rejects the config flag', () => {
      expect(parseConfig('{"ui":{"welcomeDone":true}}').ui.welcomeDone).toBe(true);
      expect(parseConfig('{}').ui.welcomeDone).toBe(undefined);
      expect(() => parseConfig('{"ui":{"welcomeDone":"yes"}}')).toThrow();
    });
  });
};
