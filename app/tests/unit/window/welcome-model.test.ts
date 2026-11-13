import { describe, expect, it } from '@gjsify/unit';

import { aiEnabled, parseConfig } from '../../../src/core/config.ts';
import type { AccountsLoadState } from '../../../src/window/accounts-model.ts';
import {
  applyAiChoice,
  applyDeltaChatChoice,
  countAccounts,
  mailAccountChoices,
  shouldShowWelcome,
  welcomePages,
  welcomeStartPage,
  welcomeSummary,
  welcomeTexts,
} from '../../../src/window/welcome-model.ts';

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

    it('walks intro, protocols, accounts, Delta Chat, AI and ends with a summary', () => {
      expect(welcomePages('linux')).toStrictEqual([
        'intro',
        'protocols',
        'accounts',
        'delta-chat',
        'ai',
        'summary',
      ]);
    });

    it('leaves out the Delta Chat page and the mail wording on Windows and macOS', () => {
      for (const platform of ['win32', 'darwin']) {
        expect(welcomePages(platform)).toStrictEqual(['intro', 'protocols', 'accounts', 'ai', 'summary']);
        const texts = welcomeTexts(platform);
        expect(texts.intro.includes('not available on this system yet')).toBe(true);
        expect(texts.protocols.startsWith('Mail is on')).toBe(false);
        expect(texts.accounts.includes('GNOME')).toBe(false);
      }
      expect(welcomeTexts('linux').protocols.startsWith('Mail is on')).toBe(true);
    });

    it('maps the screenshot hook value to a page', () => {
      expect(welcomeStartPage('1')).toBe('intro');
      expect(welcomeStartPage('delta-chat')).toBe('delta-chat');
      expect(welcomeStartPage('ai')).toBe('ai');
      expect(welcomeStartPage('nope')).toBe(undefined);
      expect(welcomeStartPage(undefined)).toBe(undefined);
    });

    it('leaves Delta Chat and AI off when nothing is touched', () => {
      const config = parseConfig('{}');
      expect(aiEnabled(config)).toBe(false);
      expect(config.mailAccounts).toBe(undefined);
      const rows = welcomeSummary(config, 0);
      expect(rows.find((r) => r.title === 'AI features')?.value).toBe('Off');
    });

    it('writes exactly the Delta Chat list and the AI flag', () => {
      const config = parseConfig('{}');
      applyDeltaChatChoice(config, 'mail-a', true);
      applyDeltaChatChoice(config, 'mail-b', true);
      applyDeltaChatChoice(config, 'mail-a', false);
      expect(config.mailAccounts).toStrictEqual({ 'mail-b': { deltaChat: true } });
      applyAiChoice(config, true);
      expect(config.ui.ai).toBe(true);
      expect(aiEnabled(config)).toBe(true);
    });

    it('offers usable mail accounts only', () => {
      const own = [
        { id: 'mail-a', identity: 'a@example.org' },
        { id: 'mail-b', identity: 'b@example.org', disabled: true },
      ];
      const state = {
        backends: [],
        goaAccounts: { accounts: [] },
        ownMailAccounts: own,
        chatAccounts: [],
        labels: new Map(),
      } as unknown as AccountsLoadState;
      expect(mailAccountChoices(state).map((c) => c.id)).toStrictEqual(['mail-a']);
    });

    it('reads and rejects the config flag', () => {
      expect(parseConfig('{"ui":{"welcomeDone":true}}').ui.welcomeDone).toBe(true);
      expect(parseConfig('{}').ui.welcomeDone).toBe(undefined);
      expect(() => parseConfig('{"ui":{"welcomeDone":"yes"}}')).toThrow();
    });
  });
};
