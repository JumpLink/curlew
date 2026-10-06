import { SmtpError } from './errors.ts';
import type { OutgoingMessage, SmtpAccount } from './types.ts';

/** `none` sends the password in the clear, so it is for a server on this machine only. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** CR, LF, NUL and the rest of C0/C1: any of them in a header value is an injection attempt. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Deliberately simple: one `@`, no whitespace, no quoting, no display name. */
const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/;

const MESSAGE_ID = /^<[^\s<>@]+@[^\s<>@]+>$/;

function config(message: string): SmtpError {
  return new SmtpError('config', message);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Throws a `config` error for anything that must not reach the network. */
export function validateAccount(account: SmtpAccount): void {
  if (!account || typeof account !== 'object') throw config('SMTP account is missing');
  const { host, port, security, username, auth, tls } = account;

  if (!nonEmptyString(host) || /\s/.test(host) || CONTROL.test(host)) throw config('SMTP host is missing or invalid');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw config('SMTP port must be 1-65535');
  if (security !== 'tls' && security !== 'starttls' && security !== 'none') {
    throw config("SMTP security must be 'tls', 'starttls' or 'none'");
  }
  if (security === 'none' && !LOOPBACK_HOSTS.has(host)) {
    throw config("security 'none' is allowed for 127.0.0.1 and localhost only");
  }
  if (!nonEmptyString(username) || CONTROL.test(username)) throw config('SMTP username is missing or invalid');

  const credential = auth as Partial<{ kind: string; password: string; accessToken: string }> | undefined;
  if (credential?.kind === 'password') {
    if (!nonEmptyString(credential.password)) throw config('SMTP password is missing');
  } else if (credential?.kind === 'oauth2') {
    if (!nonEmptyString(credential.accessToken)) throw config('SMTP access token is missing');
  } else {
    throw config("SMTP auth must be of kind 'password' or 'oauth2'");
  }

  if (tls !== undefined) {
    if (tls === null || typeof tls !== 'object') throw config('SMTP tls must be an object');
    if (tls.ca !== undefined && !nonEmptyString(tls.ca)) throw config('SMTP tls.ca must be a PEM string');
    if (tls.rejectUnauthorized !== undefined && typeof tls.rejectUnauthorized !== 'boolean') {
      throw config('SMTP tls.rejectUnauthorized must be a boolean');
    }
  }
}

function validateAddress(address: unknown, what: string): void {
  if (!nonEmptyString(address) || CONTROL.test(address) || !ADDRESS.test(address)) {
    throw config(`${what} is not a plain address (local@host)`);
  }
}

/** Throws a `config` error. Header values are checked for line breaks, not rewritten. */
export function validateMessage(message: OutgoingMessage): void {
  if (!message || typeof message !== 'object') throw config('message is missing');

  validateAddress(message.from, 'from');
  if (!Array.isArray(message.to) || message.to.length === 0) throw config('to needs at least one recipient');
  for (const address of message.to) validateAddress(address, 'to');
  if (message.cc !== undefined) {
    if (!Array.isArray(message.cc)) throw config('cc must be a list');
    for (const address of message.cc) validateAddress(address, 'cc');
  }

  if (typeof message.subject !== 'string' || CONTROL.test(message.subject)) {
    throw config('subject is missing or contains a line break or control character');
  }
  if (typeof message.text !== 'string') throw config('text is missing');
  if (message.html !== undefined && typeof message.html !== 'string') throw config('html must be a string');

  if (message.messageId !== undefined && !MESSAGE_ID.test(message.messageId)) {
    throw config('messageId must look like <id@host>');
  }

  for (const attachment of message.attachments ?? []) {
    if (!nonEmptyString(attachment?.filename) || CONTROL.test(attachment.filename)) {
      throw config('attachment filename is missing or contains a control character');
    }
    if (!(attachment.content instanceof Uint8Array)) throw config('attachment content must be a Uint8Array');
    if (
      attachment.contentType !== undefined &&
      (!nonEmptyString(attachment.contentType) || CONTROL.test(attachment.contentType))
    ) {
      throw config('attachment contentType is invalid');
    }
  }
}
