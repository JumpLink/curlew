/**
 * What the person is shown of an account. One seam, so the list, the contact page and the pickers
 * agree (docs/design/ui.md, "Delta Chat is visible"), and every read of the index that lists
 * conversations or searches messages asks here for the paused account ids to leave out, so a view
 * never filters by itself. Pausing is a read filter over the config: the messages stay in the
 * index and come back the moment the account is switched on again.
 */

import { plainMailOn, type CurlewConfig } from './config.ts';

/** The key of the derived Delta Chat carrier in the protocol tables; it is not a backend (ADR 0001 §5). */
export const DELTA_CHAT = 'deltachat';

/**
 * The protocol a thread is DISPLAYED as. A mail thread whose peer sent the chat marker is Delta
 * Chat (ADR 0014 §4), any other mail thread is E-Mail, every other backend is itself. Display
 * only: pins and routes stay on `mail`, because a pin on a derived carrier would not be sendable.
 */
export function carrierOf(
  backend: string,
  accountId: string,
  emailChat: boolean,
  config: Pick<CurlewConfig, 'mailAccounts'> = {},
): string {
  // An account with plain mail off lists only email chats, so "E-Mail" cannot arise for it.
  return backend === 'mail' && (emailChat || !plainMailOn(config, accountId)) ? DELTA_CHAT : backend;
}

/**
 * Mail accounts that show only email chats: `plainMail: false` beats the global
 * `ui.showAllEmails`. Their other mail threads stay in the index and come back on switching.
 */
export function chatOnlyAccountIds(config: Pick<CurlewConfig, 'mailAccounts'>): string[] {
  return Object.entries(config.mailAccounts ?? {})
    .filter(([, options]) => options.plainMail === false)
    .map(([id]) => id);
}

/** Account ids the person paused (`config.disabledAccounts`, entries are `<backend>/<accountId>`). */
export function hiddenAccountIds(config: Pick<CurlewConfig, 'disabledAccounts'>): string[] {
  const ids = config.disabledAccounts.map((key) => key.slice(key.indexOf('/') + 1));
  return [...new Set(ids)];
}

/** Is this account paused? */
export function isAccountPaused(
  config: Pick<CurlewConfig, 'disabledAccounts'>,
  backend: string,
  accountId: string,
): boolean {
  return config.disabledAccounts.includes(`${backend}/${accountId}`);
}
