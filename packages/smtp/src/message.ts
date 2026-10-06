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
 * The RFC 5322 message as bytes, without any network: for a preview, a log of what WOULD go out,
 * or a test. An invalid message throws a `config` SmtpError.
 */
export async function buildMessage(message: OutgoingMessage): Promise<Uint8Array> {
  const messageId = resolveMessageId(message);
  const raw = await new MailComposer(composerOptions(message, messageId)).compile().build();
  return new Uint8Array(raw);
}
