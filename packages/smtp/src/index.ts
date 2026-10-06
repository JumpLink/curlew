export { SmtpError } from './errors.ts';
export type { SmtpErrorCode } from './errors.ts';
export { buildMessage } from './message.ts';
export { sendMessage, verifyAccount } from './transport.ts';
export type { OutgoingAttachment, OutgoingMessage, SendResult, SmtpAccount } from './types.ts';
export { validateAccount, validateMessage } from './validate.ts';
