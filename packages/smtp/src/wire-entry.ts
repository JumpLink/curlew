/**
 * Entry for @curlew/smtp/wire: the wire client and what it needs, with no nodemailer in the
 * import graph. The caller brings the RFC 5322 bytes.
 */

export { SmtpError } from './errors.ts';
export type { SmtpErrorCode } from './errors.ts';
export type { SmtpAccount } from './types.ts';
export { prepareData, sendOverWire, verifyOverWire } from './wire.ts';
export type { Envelope, WireOptions, WireResult } from './wire.ts';
