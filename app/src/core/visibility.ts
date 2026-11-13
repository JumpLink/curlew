/**
 * What the person is shown of an account. One seam, so the list, the contact page and the pickers
 * agree (docs/design/ui.md, "Delta Chat is visible").
 */

import type { CurlewConfig } from './config.ts';

/** The key of the derived Delta Chat carrier in the protocol tables; it is not a backend (ADR 0001 §5). */
export const DELTA_CHAT = 'deltachat';

/**
 * The protocol a thread is DISPLAYED as. A mail thread whose peer sent the chat marker is Delta
 * Chat (ADR 0014 §4), any other mail thread is E-Mail, every other backend is itself. Display
 * only: pins and routes stay on `mail`, because a pin on a derived carrier would not be sendable.
 */
export function carrierOf(
  backend: string,
  _accountId: string,
  emailChat: boolean,
  _config: Pick<CurlewConfig, 'deltaChatAccounts'> = {},
): string {
  return backend === 'mail' && emailChat ? DELTA_CHAT : backend;
}
