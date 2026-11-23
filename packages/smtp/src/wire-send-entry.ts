/**
 * Entry for @curlew/smtp/wire-send: compose a message and send it over the wire client. The
 * composer is nodemailer's MailComposer; nodemailer's SMTP transport is not in the import graph.
 */

export { SmtpError } from './errors.ts';
export type { SmtpErrorCode } from './errors.ts';
export type { OutgoingAttachment, OutgoingMessage, SendResult, SmtpAccount } from './types.ts';
export { buildMessage } from './message.ts';
export { sendMessageOverWire } from './wire-send.ts';
export type { WireTransport } from './wire-send.ts';
export { verifyOverWire } from './wire.ts';
