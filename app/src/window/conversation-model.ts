/** Presentation rules for reading a conversation as a chat, without changing mail threading. */

import type { ConversationMessage } from '@curlew/protocol';
import { _, fmt, _n } from '@curlew/protocol';
import { normalizeSubject, type MessageCursor } from '@curlew/store';

import { protocolLabel, type ProtocolChoice } from './conversation-list-model.ts';
import { attachmentKind, type AttachmentKind } from './attachment-model.ts';

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
  const references = [
    ...new Set([...(target?.references ?? []), ...(target?.messageId ? [target.messageId] : [])]),
  ];
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
export function newOlder(
  shown: readonly ConversationMessage[],
  page: readonly ConversationMessage[],
): ConversationMessage[] {
  const have = new Set(shown.map((m) => m.id));
  return page.filter((m) => !have.has(m.id));
}

/** A run of consecutive bubbles that share a carrier; the badge sits on the run's first bubble. */
export interface ProtocolRun {
  backend: string;
}

/**
 * The ids of messages that open a new protocol run. Like sender runs in groups, a run ends when
 * the carrier changes; the first message of every run carries the protocol badge.
 */
export function protocolRunStarts(messages: readonly ConversationMessage[]): Map<string, ProtocolRun> {
  const runs = new Map<string, ProtocolRun>();
  let previous: string | null = null;
  for (const message of messages) {
    if (message.backend !== previous) runs.set(message.id, { backend: message.backend });
    previous = message.backend;
  }
  return runs;
}

/**
 * Divider texts for messages where the carrier changes from the previous one. The first message
 * starts fresh and gets no "Continuing via" line; every later switch does, once per switch.
 */
export function protocolDividers(messages: readonly ConversationMessage[]): Map<string, string> {
  const dividers = new Map<string, string>();
  for (let i = 1; i < messages.length; i++) {
    const current = messages[i]!;
    const previous = messages[i - 1]!;
    if (current.backend !== previous.backend) {
      dividers.set(
        current.id,
        fmt(_('Continuing via {protocol}'), { protocol: protocolLabel(current.backend) }),
      );
    }
  }
  return dividers;
}

/** The carrier of the last message, sent or received; null when the timeline is empty. */
export function defaultProtocolChoice(
  messages: readonly ConversationMessage[],
  choices: ProtocolChoice[],
): ProtocolChoice | null {
  if (choices.length === 0) return null;
  const last = messages[messages.length - 1];
  if (!last) return choices[0] ?? null;
  return (
    choices.find((c) => c.backend === last.backend && c.accountId === last.ref.accountId) ??
    choices.find((c) => c.backend === last.backend) ??
    choices[0] ??
    null
  );
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
export function senderRunStarts(
  messages: readonly ConversationMessage[],
  isGroup: boolean,
): Map<string, string> {
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

/** What the index knows about one attachment: mail uses `section`, chats use `index`. */
export interface AttachmentInfo {
  filename: string | null;
  mimeType: string | null;
  size?: number | null;
  /** Position in the message; mail uses `section` instead. */
  index?: number;
  /** What the UI shows it as — from the backend or derived from the MIME type. */
  kind?: AttachmentKind;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  /** IMAP section (mail only): the key to fetch the bytes with. */
  section?: string;
}

/** A message as the view shows it, with the attachment parts the index lists for it. */
export interface ShownMessage extends ConversationMessage {
  attachments?: AttachmentInfo[];
}

const MAX_ATTACHMENT_LINES = 3;

export function attachmentLine(info: AttachmentInfo): string {
  const kind = attachmentKindName(info);
  return info.filename ? fmt(_('{kind}: {name}'), { kind, name: info.filename }) : kind;
}

function attachmentKindName(info: AttachmentInfo): string {
  const kind = info.kind ?? attachmentKind(info);
  if (kind === 'image') return _('Image');
  if (kind === 'video') return _('Video');
  if (kind === 'audio' || kind === 'voice') return _('Audio');
  if (info.filename) return _('File');
  return _('Attachment');
}

/** The lines that stand in for a message without text: what it carries, else just "Attachment". */
export function attachmentLines(attachments: readonly AttachmentInfo[] | undefined): string[] {
  if (!attachments || attachments.length === 0) return [_('Attachment')];
  const lines = attachments.slice(0, MAX_ATTACHMENT_LINES).map(attachmentLine);
  const more = attachments.length - lines.length;
  if (more > 0) lines.push(fmt(_n('and {n} more attachment', 'and {n} more attachments', more), { n: more }));
  return lines;
}
