/** Presentation rules for reading a conversation as a chat, without changing mail threading. */

import type { ConversationMessage } from '@curlew/protocol';
import { _, fmt, _n } from '@curlew/protocol';
import { normalizeSubject, type MessageCursor } from '@curlew/store';

/** How many messages one page of history holds; a shorter page means the start was reached. */
export const PAGE_SIZE = 50;

export interface MailReplyTarget {
  messageId: string | null;
  references: string[];
}

export interface MailReply {
  subject: string;
  emailChat: true;
  inReplyTo?: string;
  references?: string[];
}

/** Delta Chat's conventional subject stays useful in an ordinary MUA without becoming a chat label. */
export function chatSubject(text: string): string {
  const excerpt = text.trim().split(/\s+/).join(' ').slice(0, 60);
  return excerpt ? `Chat: ${excerpt}` : 'Chat';
}

export function replySubject(subject: string | null): string {
  const clean = subject?.trim() || 'Chat';
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}

/** A UI mail send is always marked; the subject depends on whether the parent was already chat mail. */
export function composeMailReply(
  parent: ConversationMessage | null,
  target: MailReplyTarget | null,
  text: string,
): MailReply {
  const references = [...new Set([...(target?.references ?? []), ...(target?.messageId ? [target.messageId] : [])])];
  return {
    subject: parent?.emailChat ? chatSubject(text) : replySubject(parent?.subject ?? null),
    emailChat: true,
    ...(target?.messageId ? { inReplyTo: target.messageId } : {}),
    ...(references.length > 0 ? { references } : {}),
  };
}

/**
 * Ordinary mail subjects appear only when the topic changes. Marked chat mail has a generic subject
 * for MUAs and never gets a repetitive heading in the bubble stream.
 */
export function subjectLabels(messages: readonly ConversationMessage[]): Map<string, string> {
  const labels = new Map<string, string>();
  let previous: string | null = null;
  for (const message of messages) {
    if (message.backend !== 'mail' || message.emailChat) continue;
    const normalized = normalizeSubject(message.subject);
    if (normalized !== previous && message.subject?.trim()) labels.set(message.id, message.subject.trim());
    previous = normalized;
  }
  return labels;
}

/** The cursor that asks for the page just before `message`. */
export function cursorOf(message: ConversationMessage): MessageCursor {
  return { sentAt: message.sentAt, id: message.id };
}

/** What an older page adds: the messages not shown yet, so an overlap never shows one twice. */
export function newOlder(shown: readonly ConversationMessage[], page: readonly ConversationMessage[]): ConversationMessage[] {
  const have = new Set(shown.map((m) => m.id));
  return page.filter((m) => !have.has(m.id));
}

export function dayOf(message: ConversationMessage): string {
  return message.sentAt?.slice(0, 10) ?? '';
}

/** The ids of the messages a day separator goes above; a message without a time follows the day before. */
export function dayStarts(messages: readonly ConversationMessage[]): Set<string> {
  const starts = new Set<string>();
  let previous = '';
  for (const message of messages) {
    const day = dayOf(message);
    if (day && day !== previous) starts.add(message.id);
    previous = day || previous;
  }
  return starts;
}

export interface BubbleText {
  text: string;
  clipped: boolean;
}

/**
 * The part of a body a bubble lays out at first. Wrapping is what costs: a hundred bubbles of a
 * few thousand characters each kept GTK busy for over twenty seconds, so a long body shows its
 * opening lines and the rest only when asked for. The fade clamps the height; this is the guard
 * under it, because a clamped label is still laid out in full.
 */
export function bubbleText(text: string, maxChars = 1500, maxLines = 30): BubbleText {
  let end = text.length;
  let lines = 0;
  for (let i = 0; i < text.length && i < maxChars; i++) {
    if (text[i] === '\n' && ++lines >= maxLines) {
      end = i;
      break;
    }
  }
  end = Math.min(end, maxChars);
  if (end >= text.length) return { text, clipped: false };
  return { text: text.slice(0, end).trimEnd(), clipped: true };
}

/**
 * The ids of the messages that open a run of bubbles from one sender in a group, with the name to
 * show above it. A run ends when the sender changes or the person's own message comes between;
 * direct chats, the person's own messages and notices carry no label. Computed over everything
 * that is loaded, so a page prepended in front corrects the run its newest message joins.
 */
export function senderRunStarts(messages: readonly ConversationMessage[], isGroup: boolean): Map<string, string> {
  const starts = new Map<string, string>();
  if (!isGroup) return starts;
  let previous: string | null = null;
  for (const message of messages) {
    const key = message.fromSelf || message.presentation === 'notice' ? null : senderKey(message);
    if (key !== null && key !== previous) starts.set(message.id, senderName(message));
    previous = key;
  }
  return starts;
}

function senderKey(message: ConversationMessage): string | null {
  return message.senderId ?? message.senderAddress?.value ?? message.senderName?.trim() ?? null;
}

/** The name a sender is shown under: the display name, else the address, else a placeholder. */
export function senderName(message: ConversationMessage): string {
  return message.senderName?.trim() || message.senderAddress?.value || _('Unknown sender');
}
