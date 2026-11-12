/** Decisions of the first-run welcome screen, kept free of GTK so Node and GJS can test them. */

import type { AccountsLoadState } from './accounts-model.ts';

export type WelcomePageId = 'intro' | 'accounts';

/**
 * The pages in order. Extension point (package A16): the Delta Chat page (one switch per mail
 * account) and the AI switch page are inserted here once their settings exist; `welcome.ts`
 * builds a page for every id and needs a matching `case`.
 */
export function welcomePages(): WelcomePageId[] {
  return ['intro', 'accounts'];
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
