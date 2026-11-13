/**
 * The mail headers that threading and classification need, and nothing else.
 *
 * ENVELOPE carries In-Reply-To but not References, and none of the bulk-mail markers, so the
 * sync fetch asks for exactly these fields with `BODY.PEEK[HEADER.FIELDS (…)]` — a few hundred
 * bytes per message instead of the whole header block, and PEEK so `\Seen` is never set.
 */

import type { ImapValue } from './imap-parse.ts';
import { parseHeaders } from './mime-parse.ts';
import { decodeRfc2047 } from './rfc2047.ts';

/** Raw values of the headers the conversational/automated classifier reads. Null when absent. */
export interface AutomationHeaders {
  listId: string | null;
  listUnsubscribe: string | null;
  autoSubmitted: string | null;
  precedence: string | null;
}

/** The header fields fetched per message during sync. */
export const THREAD_HEADER_FIELDS: readonly string[] = [
  'REFERENCES',
  'IN-REPLY-TO',
  'LIST-ID',
  'LIST-UNSUBSCRIBE',
  'AUTO-SUBMITTED',
  'PRECEDENCE',
  'CHAT-VERSION',
  'CONTENT-DISPOSITION',
  'CHAT-EDIT',
  'CHAT-DELETE',
  'CHAT-VOICE-MESSAGE',
  'CHAT-DURATION',
  'CHAT-CONTENT',
  'CONTENT-TYPE',
  'CHAT-DISPOSITION-NOTIFICATION-TO',
];

/** The FETCH item that asks for them without setting `\Seen`. */
export function threadHeaderFetchItem(): string {
  return `BODY.PEEK[HEADER.FIELDS (${THREAD_HEADER_FIELDS.join(' ')})]`;
}

/**
 * Pull the `BODY[HEADER.FIELDS (…)]` literal out of a tokenized FETCH response.
 *
 * Matched by prefix, because the server echoes the field list in its own spelling and order —
 * comparing it against what was sent would miss a server that normalises the case.
 */
export function extractHeaderFields(items: ImapValue[]): string {
  for (let i = 0; i + 1 < items.length; i += 2) {
    if (/^BODY\[HEADER\.FIELDS[ \]]/i.test(String(items[i]))) {
      const value = items[i + 1];
      return typeof value === 'string' ? value : '';
    }
  }
  return '';
}

/**
 * Every `<message-id>` in a References or In-Reply-To value, in order, duplicates dropped.
 *
 * Only the bracketed form counts. In-Reply-To in the wild also carries prose (`<id> (Anna's
 * message of Monday)`) and some clients write bare ids; a bare token that is not bracketed is
 * too ambiguous to thread on, so it is ignored rather than guessed at.
 */
export function parseMessageIdList(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(/<([^<>\s]+)>/g)) {
    const id = `<${match[1]}>`;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export interface ThreadHeaders {
  references: string[];
  inReplyTo: string | null;
  automation: AutomationHeaders;
  /** Only version 1.0 is understood; a future version is not guessed at. */
  emailChat: boolean;
  /** `Content-Disposition: reaction` (RFC 9078): the body is an emoji, not a message. */
  reaction: boolean;
  /** `Chat-Edit`: the Message-ID (`<id@host>`) whose text this mail replaces; the body is the new text. */
  chatEdit: string | null;
  /** `Chat-Delete`: the Message-ID of the message this mail asks to delete; the body is ignored. */
  chatDelete: string | null;
  /** Delta Chat's `Chat-Voice-Message: 1` / `Chat-Content: sticker`; only meaningful with `emailChat`. */
  chatContent: 'voice' | 'sticker' | null;
  /** `Chat-Duration` in milliseconds; null when absent or not a number (never an error). */
  durationMs: number | null;
  /** The mail is a read receipt (`multipart/report; report-type=disposition-notification`, RFC 8098). */
  mdn: boolean;
  /**
   * `Chat-Disposition-Notification-To`: the address the sender wants a read receipt at. Only this
   * Delta Chat header counts; the plain `Disposition-Notification-To` is never read, because
   * answering that would confirm to every mailing list that someone looked.
   */
  receiptTo: string | null;
}

/** The Message-ID in angle brackets: Delta Chat writes these two headers with or without them. */
function bracketedId(value: string | null): string | null {
  const id = value?.replace(/^<|>$/g, '') ?? '';
  return id && !/[\s<>]/.test(id) ? `<${id}>` : null;
}

/** Parse the fetched header block into threading and classification input. */
export function parseThreadHeaders(block: string): ThreadHeaders {
  const headers = parseHeaders(block);
  const get = (name: string): string | null => {
    const value = headers.get(name)?.trim();
    return value ? decodeRfc2047(value) : null;
  };
  const inReplyTo = parseMessageIdList(headers.get('in-reply-to'));
  const emailChat = get('chat-version') === '1.0';
  const duration = get('chat-duration');
  const durationMs = duration !== null && /^\d{1,9}$/.test(duration) ? Number.parseInt(duration, 10) : null;
  const chatContent: ThreadHeaders['chatContent'] = !emailChat
    ? null
    : get('chat-voice-message') === '1'
      ? 'voice'
      : get('chat-content')?.toLowerCase() === 'sticker'
        ? 'sticker'
        : null;
  return {
    references: parseMessageIdList(headers.get('references')),
    inReplyTo: inReplyTo[0] ?? null,
    automation: {
      listId: get('list-id'),
      listUnsubscribe: get('list-unsubscribe'),
      autoSubmitted: get('auto-submitted'),
      precedence: get('precedence'),
    },
    emailChat,
    reaction: /^reaction\s*(;|$)/i.test(get('content-disposition') ?? ''),
    chatEdit: bracketedId(get('chat-edit')),
    chatDelete: bracketedId(get('chat-delete')),
    chatContent,
    durationMs: chatContent === 'voice' ? durationMs : null,
    mdn: isDispositionNotification(get('content-type')),
    receiptTo: receiptAddress(get('chat-disposition-notification-to')),
  };
}

/** `multipart/report` whose `report-type` is `disposition-notification`: a read receipt, not a message. */
export function isDispositionNotification(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return (
    /^\s*multipart\/report\s*(;|$)/i.test(contentType) &&
    /;\s*report-type\s*=\s*"?disposition-notification"?\s*(;|$)/i.test(contentType)
  );
}

/** The lowercase `local@host` of a `Chat-Disposition-Notification-To` value (`<a@b>`, `Name <a@b>` or bare), or null. */
function receiptAddress(value: string | null): string | null {
  const text = value?.trim() ?? '';
  const match = /<([^<>\s@]+@[^<>\s@]+)>/.exec(text) ?? /^([^<>\s@,;]+@[^<>\s@,;]+)$/.exec(text);
  return match ? match[1].toLowerCase() : null;
}

/** What the `message/disposition-notification` part of a read receipt says. */
export interface DispositionNotification {
  /** `Original-Message-ID` (`<id@host>`): the message that was read. */
  originalMessageId: string | null;
  /** The disposition type is `displayed`: the person saw it. Anything else (deleted, denied) is no read receipt. */
  displayed: boolean;
}

/** Read the fields of a decoded `message/disposition-notification` part. Never throws. */
export function parseDispositionNotification(text: string): DispositionNotification {
  const fields = parseHeaders(text.replace(/^\s+/, ''));
  const disposition = fields.get('disposition') ?? '';
  return {
    originalMessageId: bracketedId(fields.get('original-message-id')?.trim() || null),
    // `manual-action/MDN-sent-manually; displayed`: the type follows the last semicolon (RFC 8098 §3.2.6).
    displayed: /;\s*displayed\b/i.test(disposition),
  };
}
