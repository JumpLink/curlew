/** Decisions of the first-run welcome screen, kept free of GTK so Node and GJS can test them. */

import { _, _n, fmt } from '@curlew/protocol';

import { chatOnly, currentPlatform, type PlatformName } from '../core/platform.ts';
import { aiEnabled, setDeltaChatIn, type CurlewConfig } from '../core/config.ts';
import { buildProtocolGroups, type AccountsLoadState } from './accounts-model.ts';
import { protocolLabel } from './conversation-list-model.ts';

export type WelcomePageId = 'intro' | 'protocols' | 'accounts' | 'delta-chat' | 'ai' | 'summary';

/**
 * The pages in order: what Curlew is, then the decisions only the person can make, then a
 * summary. `welcome.ts` builds a page for every id and needs a matching `case`. No page forces an
 * input; leaving every one untouched keeps the safe defaults (Delta Chat off, AI off).
 */
export function welcomePages(platform: PlatformName = currentPlatform()): WelcomePageId[] {
  // Delta Chat is a way of using a mail account; a chat-only platform has none.
  return chatOnly(platform)
    ? ['intro', 'protocols', 'accounts', 'ai', 'summary']
    : ['intro', 'protocols', 'accounts', 'delta-chat', 'ai', 'summary'];
}

/** The welcome texts that name mail; chat-only platforms say what they offer instead. */
export function welcomeTexts(platform: PlatformName = currentPlatform()): {
  intro: string;
  protocols: string;
  accounts: string;
} {
  if (chatOnly(platform)) {
    return {
      intro: _(
        'Curlew brings your chat accounts together in one conversation list. Mail, contacts and calendar are not available on this system yet.',
      ),
      protocols: _(
        'Switch on a chat protocol to use it; some ask you to read a notice first. You can change this later in Accounts.',
      ),
      accounts: _('Choose Add Account to sign in to a chat. You can add more later from the menu.'),
    };
  }
  return {
    intro: _('Curlew brings your mail and chat accounts together in one conversation list.'),
    protocols: _(
      'Mail is on. Switch on a chat protocol to use it; some ask you to read a notice first. You can change this later in Accounts.',
    ),
    accounts: _(
      'Mail accounts from GNOME Online Accounts appear on their own. Otherwise choose Add Account, then Mail. You can add more later from the menu.',
    ),
  };
}

export interface MailAccountChoice {
  id: string;
  label: string;
}

/** The mail accounts Delta Chat can be switched on for: every usable one, GNOME Online Accounts too. */
export function mailAccountChoices(load: AccountsLoadState): MailAccountChoice[] {
  const group = buildProtocolGroups(load, { present: false, accounts: new Map() }).groups.find(
    (g) => g.backend === 'mail',
  );
  return (group?.rows ?? [])
    .filter((row) => row.status !== 'disabled')
    .map((row) => ({ id: row.id, label: row.label }));
}

/** Opt one mail account into Delta Chat or out again; writes the one config field and nothing else. */
export function applyDeltaChatChoice(config: CurlewConfig, accountId: string, on: boolean): void {
  setDeltaChatIn(config, accountId, on);
}

/** Set the AI switch; an explicit value, so a later change of defaults cannot flip it. */
export function applyAiChoice(config: CurlewConfig, on: boolean): void {
  config.ui.ai = on;
}

export interface SummaryRow {
  title: string;
  value: string;
}

/** What the person ended up with, one line each, for the last page. */
export function welcomeSummary(config: CurlewConfig, accountCount: number): SummaryRow[] {
  const protocols = Object.entries(config.backends)
    .filter(([, backend]) => backend.enabled)
    .map(([name]) => protocolLabel(name));
  const deltaChat = config.deltaChatAccounts?.length ?? 0;
  return [
    { title: _('Protocols'), value: protocols.length > 0 ? protocols.join(', ') : _('None') },
    {
      title: _('Accounts'),
      value:
        accountCount === 0
          ? _('None yet')
          : fmt(_n('{count} account', '{count} accounts', accountCount), { count: accountCount }),
    },
    {
      title: _('Delta Chat'),
      value:
        deltaChat === 0
          ? _('Off for every account')
          : fmt(_n('On for {count} account', 'On for {count} accounts', deltaChat), { count: deltaChat }),
    },
    { title: _('AI features'), value: aiEnabled(config) ? _('On') : _('Off') },
  ];
}

/** How many accounts exist across mail (own and GNOME Online Accounts) and every chat protocol. */
export function countAccounts(load: AccountsLoadState): number {
  return (
    load.goaAccounts.accounts.length +
    (load.ownMailAccounts?.length ?? 0) +
    load.chatAccounts.reduce((sum, group) => sum + group.accounts.length, 0)
  );
}

/**
 * Show the screen on a first start only. Somebody who already has accounts is an existing user and
 * never sees it on its own; the flag, not the account count, keeps it away after a removal.
 */
export function shouldShowWelcome(welcomeDone: boolean | undefined, accountCount: number): boolean {
  return welcomeDone !== true && accountCount === 0;
}

/** The page a screenshot asks for: `1` is the first page, an id opens that page, anything else none. */
export function welcomeStartPage(value: string | undefined): WelcomePageId | undefined {
  if (value === '1') return welcomePages()[0];
  return welcomePages().find((id) => id === value);
}
