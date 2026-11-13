import MailComposer from 'nodemailer/lib/mail-composer';
import type { MailComposerOptions } from 'nodemailer/lib/mail-composer';

import type { OutgoingMessage } from './types.ts';
import { validateMessage } from './validate.ts';

function randomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The message's own id, or a fresh `<random@domain-of-from>`. Validates the message first. */
export function resolveMessageId(message: OutgoingMessage): string {
  validateMessage(message);
  if (message.messageId) return message.messageId;
  return `<${randomId()}@${message.from.slice(message.from.lastIndexOf('@') + 1)}>`;
}

/**
 * What goes to nodemailer: file and URL access are off, so no attachment can name a path or a
 * URL — content is bytes the caller handed over, nothing else.
 */
export function composerOptions(message: OutgoingMessage, messageId: string): MailComposerOptions {
  return {
    from: message.from,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    text: message.text,
    html: message.html,
    messageId,
    headers: {
      ...(message.emailChat ? { 'Chat-Version': '1.0' } : {}),
      ...(message.chatEdit ? { 'Chat-Edit': message.chatEdit.slice(1, -1) } : {}),
      ...(message.chatDelete ? { 'Chat-Delete': message.chatDelete.slice(1, -1) } : {}),
      ...(message.readReceipt ? { 'Chat-Disposition-Notification-To': `<${message.from}>` } : {}),
      ...(message.reaction ? { 'Content-Disposition': 'reaction' } : {}),
      ...(message.emailChat && message.voiceMessage ? { 'Chat-Voice-Message': '1' } : {}),
      ...(message.emailChat && message.voiceMessage && message.durationMs !== undefined
        ? { 'Chat-Duration': String(message.durationMs) }
        : {}),
      ...(message.emailChat && message.sticker ? { 'Chat-Content': 'sticker' } : {}),
      ...(message.inReplyTo ? { 'In-Reply-To': message.inReplyTo } : {}),
      ...(message.references && message.references.length > 0 ? { References: message.references.join(' ') } : {}),
    },
    attachments: (message.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      content: Buffer.from(attachment.content),
      contentType: attachment.contentType,
    })),
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

/**
 * A read receipt as Delta Chat writes and reads it (RFC 8098): `multipart/report` with a short
 * human part and a `message/disposition-notification` part naming the message that was read.
 * Written by hand, because the composer cannot make a `multipart/report` root. Every value is
 * validated first, so no field can carry a line break.
 */
export function readReceiptSource(message: OutgoingMessage, messageId: string, now = new Date()): string {
  const original = message.mdn;
  if (original === undefined) throw new Error('not a read receipt');
  const boundary = `curlew-mdn-${messageId.slice(1, messageId.indexOf('@')).replace(/[^A-Za-z0-9]/g, '')}`;
  const lines = [
    `From: <${message.from}>`,
    `To: <${message.to[0]}>`,
    `Subject: Read receipt`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: ${messageId}`,
    `In-Reply-To: ${original}`,
    `References: ${original}`,
    'MIME-Version: 1.0',
    'Chat-Version: 1.0',
    'Auto-Submitted: auto-replied',
    `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'This is a read receipt. It confirms that your message was displayed.',
    '',
    `--${boundary}`,
    'Content-Type: message/disposition-notification',
    '',
    'Reporting-UA: Curlew',
    `Original-Recipient: rfc822;${message.from}`,
    `Final-Recipient: rfc822;${message.from}`,
    `Original-Message-ID: ${original}`,
    'Disposition: manual-action/MDN-sent-automatically; displayed',
    '',
    `--${boundary}--`,
    '',
  ];
  return lines.join('\r\n');
}

/**
 * The RFC 5322 message as bytes, without any network: for a preview, a log of what WOULD go out,
 * or a test. An invalid message throws a `config` SmtpError.
 */
export async function buildMessage(message: OutgoingMessage): Promise<Uint8Array> {
  const messageId = resolveMessageId(message);
  if (message.mdn !== undefined) return new TextEncoder().encode(readReceiptSource(message, messageId));
  const raw = await new MailComposer(composerOptions(message, messageId)).compile().build();
  return new Uint8Array(raw);
}
