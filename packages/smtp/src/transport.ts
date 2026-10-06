import { createTransport } from 'nodemailer';
import type { NodemailerError } from 'nodemailer/lib/errors';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

import { SmtpError } from './errors.ts';
import type { SmtpErrorCode } from './errors.ts';
import { composerOptions, resolveMessageId } from './message.ts';
import type { OutgoingMessage, SendResult, SmtpAccount } from './types.ts';
import { validateAccount } from './validate.ts';

/** A dead server must end as an error, not as a hang. */
const CONNECTION_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 60_000;

/** Longest server reply text that goes into an error message. */
const MAX_REPLY_LENGTH = 200;

const BY_LIBRARY_CODE: Record<string, SmtpErrorCode> = {
  EAUTH: 'auth',
  ENOAUTH: 'auth',
  EOAUTH2: 'auth',
  ETLS: 'tls',
  EREQUIRETLS: 'tls',
  EENVELOPE: 'rejected',
  EMESSAGE: 'rejected',
  EMAXRECIPIENTS: 'rejected',
  ECONFIG: 'config',
};

const SUMMARY: Record<SmtpErrorCode, string> = {
  auth: 'SMTP login failed',
  tls: 'SMTP TLS handshake failed',
  connect: 'SMTP connection failed',
  rejected: 'SMTP server rejected the message',
  config: 'SMTP configuration is invalid',
};

function secretsOf(account: SmtpAccount): string[] {
  return account.auth.kind === 'password' ? [account.auth.password] : [account.auth.accessToken];
}

/** The reply text with every form of a secret removed, flattened to one bounded line. */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    for (const form of [secret, btoa(secret)]) out = out.split(form).join('[redacted]');
  }
  return out.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, MAX_REPLY_LENGTH);
}

/**
 * What the caller sees of a library error: a code, fixed text, the numeric reply code, and the
 * server's reply text with the account's secrets cut out. The original error is dropped.
 */
function toSmtpError(err: unknown, account: SmtpAccount): SmtpError {
  const failure = (err ?? {}) as NodemailerError;
  const code = BY_LIBRARY_CODE[failure.code ?? ''] ?? (failure.responseCode === 535 ? 'auth' : 'connect');
  const reply = typeof failure.response === 'string' ? scrub(failure.response, secretsOf(account)) : '';
  const message = reply ? `${SUMMARY[code]}: ${reply}` : SUMMARY[code];
  return new SmtpError(code, message, failure.responseCode);
}

function transportFor(account: SmtpAccount) {
  const options: SMTPTransport.Options = {
    host: account.host,
    port: account.port,
    secure: account.security === 'tls',
    requireTLS: account.security === 'starttls',
    ignoreTLS: account.security === 'none',
    auth:
      account.auth.kind === 'password'
        ? { user: account.username, pass: account.auth.password }
        : { type: 'OAuth2', user: account.username, accessToken: account.auth.accessToken },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    // The libraries' loggers print whole SMTP dialogues, AUTH lines included.
    logger: false,
    debug: false,
  };
  if (account.tls) {
    options.tls = {};
    if (account.tls.ca !== undefined) options.tls.ca = account.tls.ca;
    if (account.tls.rejectUnauthorized !== undefined) {
      options.tls.rejectUnauthorized = account.tls.rejectUnauthorized;
    }
  }
  return createTransport(options);
}

/**
 * Connects and logs in, then hangs up: no MAIL FROM, nothing is sent. Resolves when the server
 * accepted the credentials; otherwise throws an SmtpError.
 */
export async function verifyAccount(account: SmtpAccount): Promise<void> {
  validateAccount(account);
  const transport = transportFor(account);
  try {
    await transport.verify();
  } catch (err) {
    throw toSmtpError(err, account);
  } finally {
    transport.close();
  }
}

/**
 * Sends one message. The caller decides whether to; this never asks anyone. `rejected` lists the
 * recipients the server refused while taking the rest — when it took none, that is an
 * SmtpError('rejected').
 */
export async function sendMessage(account: SmtpAccount, message: OutgoingMessage): Promise<SendResult> {
  validateAccount(account);
  const messageId = resolveMessageId(message);
  const transport = transportFor(account);
  try {
    const info = await transport.sendMail(composerOptions(message, messageId));
    const accepted = info.accepted.map(String);
    if (accepted.length === 0) throw new SmtpError('rejected', SUMMARY.rejected);
    return { messageId, accepted, rejected: info.rejected.map(String), response: scrub(info.response, secretsOf(account)) };
  } catch (err) {
    throw err instanceof SmtpError ? err : toSmtpError(err, account);
  } finally {
    transport.close();
  }
}
