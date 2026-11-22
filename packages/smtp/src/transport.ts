import { createTransport } from 'nodemailer';
import type { NodemailerError } from 'nodemailer/lib/errors';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

import { SmtpError } from './errors.ts';
import { scrub, secretsOf, SUMMARY } from './scrub.ts';
import type { SmtpErrorCode } from './errors.ts';
import { composerOptions, rawMessage, readReceiptSource, resolveMessageId } from './message.ts';
import type { OutgoingMessage, SendResult, SmtpAccount } from './types.ts';
import { validateAccount } from './validate.ts';
import { sendOverWire, verifyOverWire } from './wire.ts';
import type { WireOptions } from './wire.ts';
import type { MailEndpointOpener } from '@curlew/protocol';

/**
 * Opt-in: speak SMTP ourselves over this opener instead of handing the connection to nodemailer
 * (ADR 0018 amendment). Without it the nodemailer transport runs, as before.
 */
export interface WireTransport extends WireOptions {
  open: MailEndpointOpener;
}

/** A dead server must end as an error, not as a hang. */
const CONNECTION_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 60_000;

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

/**
 * nodemailer reports a failed handshake as `ESOCKET` (or `ECONNECTION`) and overwrites the
 * underlying code, so a refused certificate would read as "no connection". The text is what is left.
 */
const TLS_FAILURE = /certificate|self[- ]signed|handshake|\bTLS\b|\bSSL\b|altnames|CERT_|ERR_TLS/i;

/**
 * What the caller sees of a library error: a code, fixed text, the numeric reply code, and the
 * server's reply text with the account's secrets cut out. The original error is dropped.
 */
function toSmtpError(err: unknown, account: SmtpAccount): SmtpError {
  const failure = (err ?? {}) as NodemailerError;
  const fromText = TLS_FAILURE.test(String(failure.message ?? '')) ? 'tls' : 'connect';
  const code = BY_LIBRARY_CODE[failure.code ?? ''] ?? (failure.responseCode === 535 ? 'auth' : fromText);
  const reply = typeof failure.response === 'string' ? scrub(failure.response, secretsOf(account)) : '';
  const message = reply ? `${SUMMARY[code]}: ${reply}` : SUMMARY[code];
  const text = typeof failure.message === 'string' ? scrub(failure.message, secretsOf(account)) : '';
  const detail = [failure.code, text].filter(Boolean).join(': ') || undefined;
  return new SmtpError(code, message, failure.responseCode, detail);
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
export async function verifyAccount(account: SmtpAccount, wire?: WireTransport): Promise<void> {
  validateAccount(account);
  if (wire) return verifyOverWire(account, wire.open, wire);
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
export async function sendMessage(
  account: SmtpAccount,
  message: OutgoingMessage,
  wire?: WireTransport,
): Promise<SendResult> {
  validateAccount(account);
  const messageId = resolveMessageId(message);
  if (wire) {
    const to = message.mdn === undefined ? [...message.to, ...(message.cc ?? [])] : message.to;
    const result = await sendOverWire(
      account,
      { from: message.from, to },
      await rawMessage(message, messageId),
      wire.open,
      wire,
    );
    return { messageId, ...result };
  }
  const transport = transportFor(account);
  try {
    const info = await transport.sendMail(
      message.mdn === undefined
        ? composerOptions(message, messageId)
        : { envelope: { from: message.from, to: message.to }, raw: readReceiptSource(message, messageId) },
    );
    const accepted = info.accepted.map(String);
    if (accepted.length === 0) throw new SmtpError('rejected', SUMMARY.rejected);
    return { messageId, accepted, rejected: info.rejected.map(String), response: scrub(info.response, secretsOf(account)) };
  } catch (err) {
    throw err instanceof SmtpError ? err : toSmtpError(err, account);
  } finally {
    transport.close();
  }
}
