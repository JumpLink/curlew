/**
 * Which new messages deserve a desktop notification, and what it says. Pure: the daemon feeds it
 * the journal rows it just read, `access-notifications.ts`-style transport shows the result.
 *
 * Only chats notify. Mail stays quiet: an inbox is not a conversation, and the first sync of a
 * mailbox would otherwise bury the desktop. A chat notifies for incoming, unread messages sent
 * after the daemon came up, so catching up on a backlog is silent.
 */

import { _, _n, fmt, type ConversationMessage } from '@curlew/protocol';
import { getConversation, type ChangeRow, type IndexDatabase } from '@curlew/store';

/** What a notification may show: the text, only who wrote, or nothing at all. */
export type NoticeMode = 'preview' | 'sender' | 'off';

export interface Notice {
  conversationId: string;
  title: string;
  body: string;
  /** The newest message the notice stands for: what a later notice for the chat builds on. */
  messageId: string;
}

/** What the daemon remembers between two polls. */
export interface NoticeState {
  /** Messages sent before this are history. */
  since: string;
  /** Per conversation: the newest message already announced. */
  announced: Map<string, string>;
}

export function newNoticeState(now: Date = new Date()): NoticeState {
  return { since: now.toISOString(), announced: new Map() };
}

/** More chats than this in one poll become one summary instead of a pile of notifications. */
export const MAX_NOTICES_PER_POLL = 4;
const MAX_LINES = 3;
const MAX_LINE_CHARS = 140;

function line(message: ConversationMessage, group: boolean): string {
  const text = (message.bodyText ?? '').trim().replace(/\s+/g, ' ');
  const shown =
    text.length > MAX_LINE_CHARS
      ? `${text.slice(0, MAX_LINE_CHARS - 1)}…`
      : text || (message.hasAttachments ? _('Sent an attachment') : _('New message'));
  return group && message.senderName ? `${message.senderName}: ${shown}` : shown;
}

/** The chats the journal rows touched, in the order they were first named. */
function touchedChats(changes: readonly ChangeRow[]): string[] {
  const ids = new Set<string>();
  for (const change of changes) if (change.kind === 'messages' && change.conversationId) ids.add(change.conversationId);
  return [...ids];
}

/**
 * The notices for the journal rows `changes`, and the state advanced past them. `mode` `off`
 * returns nothing and leaves the state alone, so switching it on later does not replay anything:
 * `since` moves along with the polls.
 */
export function planNotices(
  db: IndexDatabase,
  changes: readonly ChangeRow[],
  mode: NoticeMode,
  state: NoticeState,
  hiddenAccounts: readonly string[] = [],
): Notice[] {
  if (mode === 'off') return [];
  const notices: Notice[] = [];
  for (const conversationId of touchedChats(changes)) {
    const found = getConversation(db, conversationId, {
      includeBodies: mode === 'preview',
      maxBodyChars: MAX_LINE_CHARS * 2,
      since: state.since,
      incomingOnly: true,
    });
    if (!found || found.conversation.backend === 'mail') continue;
    // A paused account stays silent: its messages may still sit in the index.
    if (hiddenAccounts.includes(found.conversation.accountId)) continue;
    const already = state.announced.get(conversationId);
    let fresh = found.messages.filter((m) => !m.seen && m.presentation !== 'notice');
    if (already !== undefined) {
      const at = fresh.findIndex((m) => m.id === already);
      if (at !== -1) fresh = fresh.slice(at + 1);
    }
    const newest = fresh[fresh.length - 1];
    if (!newest) continue;
    state.announced.set(conversationId, newest.id);
    const group = found.conversation.kind === 'group';
    const title = found.conversation.title || newest.senderName || _('New message');
    const body =
      mode === 'preview'
        ? fresh
            .slice(-MAX_LINES)
            .map((m) => line(m, group))
            .join('\n')
        : fresh.length === 1
          ? group && newest.senderName
            ? fmt(_('{name} wrote a message'), { name: newest.senderName })
            : _('New message')
          : fmt(_n('{n} new message', '{n} new messages', fresh.length), { n: fresh.length });
    notices.push({ conversationId, title, body, messageId: newest.id });
  }
  if (notices.length <= MAX_NOTICES_PER_POLL) return notices;
  const shown = notices.slice(0, MAX_NOTICES_PER_POLL - 1);
  const rest = notices.length - shown.length;
  const last = notices[notices.length - 1];
  return [
    ...shown,
    {
      conversationId: last.conversationId,
      title: 'Curlew',
      body: fmt(_n('{n} more chat has new messages', '{n} more chats have new messages', rest), { n: rest }),
      messageId: last.messageId,
    },
  ];
}
