/**
 * The words that explain email chats, and when the hint in a thread shows. Pure, so both runtimes
 * test that what the interface promises is what the list filter and the opt-in actually do.
 */

import { _ } from '@curlew/protocol';

/** What Delta Chat mode does for a mail account, for the account page and the welcome screen. */
export function emailChatExplanation(): string {
  return _(
    'People using Delta Chat, ArcaneChat or DeltaTouch see messages from this account as a chat. Everyone else sees an ordinary email. Curlew offers chat features only in threads where the other side sent the chat marker.',
  );
}

/** Why ordinary mail is missing from the list, and where it comes back. */
export function hiddenMailNote(): string {
  return _('Ordinary email is hidden. To see it, switch on "Show all emails" in Preferences, Conversations.');
}

/** What the "Show all emails" switch does: it filters the list and nothing else. */
export function showAllEmailsSubtitle(): string {
  return _('Off lists only email chats. This changes the list only, never how mail is sent');
}

/** The one-line hint above the first email chat of an account. */
export function emailChatHint(): string {
  return _(
    'This is an email chat: people with Delta Chat, ArcaneChat or DeltaTouch see it as a chat, everyone else as an ordinary email. A contact shows as Delta Chat once their app has sent the chat marker, and as Mail before that.',
  );
}

/**
 * Show the hint above a thread? Only in an email chat (the other side sent the chat marker) of a
 * mail account, and once per account: the dismissed ones are kept in `ui.emailChatHintSeen`.
 */
export function shouldShowEmailChatHint(
  entry: { backend: string; emailChat: boolean; accountId: string },
  seen: readonly string[] | undefined,
): boolean {
  return entry.backend === 'mail' && entry.emailChat && !(seen ?? []).includes(entry.accountId);
}

/** The list of dismissed accounts with one more added; the same list when it is already there. */
export function withHintSeen(seen: readonly string[] | undefined, accountId: string): string[] {
  const list = seen ?? [];
  return list.includes(accountId) ? [...list] : [...list, accountId];
}

/** The text above the switches on the welcome screen's Delta Chat page: what it does, then where mail went. */
export function deltaChatPageText(): string {
  return `${emailChatExplanation()}\n\n${hiddenMailNote()}`;
}
