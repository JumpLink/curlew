/**
 * The SMTP wire client over the `ByteStream` port (ADR 0018, amendment).
 *
 * Only the protocol is here: EHLO/HELO, STARTTLS, AUTH, the envelope and DATA. The message bytes
 * come from the caller (the composer in `message.ts`, or anything else that yields RFC 5322), so
 * this file imports no nodemailer and no `node:*` and bundles for a platform that has neither.
 *
 * Nothing is logged. Credentials only leave in the AUTH exchange, and every server text that
 * reaches an error has the account's secrets cut out first.
 */

import { ByteReader, type MailEndpoint, type MailEndpointOpener, type UpgradableByteStream } from '@curlew/protocol';

import { SmtpError, type SmtpErrorCode } from './errors.ts';
import { scrub, secretsOf, SUMMARY } from './scrub.ts';
import type { SmtpAccount } from './types.ts';
import { validateAccount } from './validate.ts';

export interface WireOptions {
  /** Per reply and per write; a silent server ends as a `connect` error. Default 30 s. */
  timeoutMs?: number;
  /** The name given to EHLO. Default `localhost`. */
  clientName?: string;
}

export interface Envelope {
  from: string;
  to: string[];
}

export interface WireResult {
  accepted: string[];
  rejected: string[];
  /** The server's final reply to the message, scrubbed. */
  response: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const QUIT_TIMEOUT_MS = 2_000;
const MAX_REPLY_LINES = 200;
const TLS_FAILURE = /certificate|self[- ]signed|handshake|\bTLS\b|\bSSL\b|altnames|CERT_|ERR_TLS/i;
const ENVELOPE_UNSAFE = /[\u0000-\u001f\u007f<>]/;

interface Reply {
  code: number;
  lines: string[];
}

const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The bytes of `raw` as DATA wants them (RFC 5321 § 4.5.2): every line ends in CRLF (bare LF and
 * bare CR are converted), a line that starts with `.` gets a second one, and the terminating
 * `.` line is appended.
 */
export function prepareData(raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(raw.length * 2 + 8);
  let n = 0;
  let lineStart = true;
  for (let i = 0; i < raw.length; i++) {
    const byte = raw[i];
    if (byte === 0x0d || byte === 0x0a) {
      if (byte === 0x0d && raw[i + 1] === 0x0a) i++;
      out[n++] = 0x0d;
      out[n++] = 0x0a;
      lineStart = true;
      continue;
    }
    if (lineStart && byte === 0x2e) out[n++] = 0x2e;
    out[n++] = byte;
    lineStart = false;
  }
  if (!lineStart) {
    out[n++] = 0x0d;
    out[n++] = 0x0a;
  }
  out[n++] = 0x2e;
  out[n++] = 0x0d;
  out[n++] = 0x0a;
  return out.subarray(0, n);
}

class Timeout extends Error {}

async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Timeout('timeout')), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

class Session {
  private readonly account: SmtpAccount;
  private readonly secrets: string[];
  private readonly timeoutMs: number;
  private readonly clientName: string;
  private stream: UpgradableByteStream | null = null;
  private reader: ByteReader | null = null;
  private capabilities = new Map<string, string>();

  constructor(account: SmtpAccount, options: WireOptions) {
    this.account = account;
    this.secrets = secretsOf(account);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.clientName = options.clientName ?? 'localhost';
  }

  private error(code: SmtpErrorCode, reply?: Reply, detail?: string): SmtpError {
    const text = reply ? scrub(reply.lines.join(' '), this.secrets) : '';
    const message = text ? `${SUMMARY[code]}: ${text}` : SUMMARY[code];
    return new SmtpError(code, message, reply?.code, detail ? scrub(detail, this.secrets) : undefined);
  }

  /** A transport failure as the caller's error: a timeout and a dead peer are `connect`. */
  private transportError(err: unknown): SmtpError {
    if (err instanceof SmtpError) return err;
    if (err instanceof Timeout) return this.error('connect', undefined, 'timeout');
    const text = err instanceof Error ? err.message : String(err);
    return this.error(TLS_FAILURE.test(text) ? 'tls' : 'connect', undefined, text);
  }

  private async guard<T>(work: Promise<T>): Promise<T> {
    try {
      return await within(work, this.timeoutMs);
    } catch (err) {
      throw this.transportError(err);
    }
  }

  private async send(bytes: Uint8Array): Promise<void> {
    if (!this.stream) throw this.error('connect', undefined, 'not connected');
    await this.guard(this.stream.write(bytes));
  }

  private async reply(): Promise<Reply> {
    if (!this.reader) throw this.error('connect', undefined, 'not connected');
    const lines: string[] = [];
    let code = 0;
    while (lines.length < MAX_REPLY_LINES) {
      const line = await this.guard(this.reader.readLine());
      if (line === null) throw this.error('connect', undefined, 'connection closed');
      const match = /^(\d{3})(?:([ -])(.*))?$/.exec(line);
      if (!match) throw this.error('connect', undefined, 'reply is not SMTP');
      const current = Number(match[1]);
      if (lines.length > 0 && current !== code) throw this.error('connect', undefined, 'reply code changed mid-reply');
      code = current;
      lines.push(match[3] ?? '');
      if (match[2] !== '-') return { code, lines };
    }
    throw this.error('connect', undefined, 'reply is too long');
  }

  private async command(line: string): Promise<Reply> {
    await this.send(encoder.encode(`${line}\r\n`));
    return this.reply();
  }

  private async ehlo(): Promise<void> {
    let reply = await this.command(`EHLO ${this.clientName}`);
    if (reply.code >= 500) reply = await this.command(`HELO ${this.clientName}`);
    if (reply.code !== 250) throw this.error('connect', reply);
    this.capabilities = new Map();
    for (const line of reply.lines.slice(1)) {
      const [key, ...rest] = line.trim().split(/\s+/);
      if (key) this.capabilities.set(key.toUpperCase(), rest.join(' '));
    }
  }

  private async upgrade(): Promise<void> {
    if (!this.capabilities.has('STARTTLS')) throw this.error('tls', undefined, 'server does not offer STARTTLS');
    const reply = await this.command('STARTTLS');
    if (reply.code !== 220) throw this.error('tls', reply);
    // Bytes the server sent before the handshake would be read as if they were encrypted.
    if (this.reader && this.reader.buffered > 0) {
      throw this.error('tls', undefined, 'unexpected data before the TLS handshake');
    }
    try {
      await within(this.stream!.upgradeTls(), this.timeoutMs);
    } catch (err) {
      const text = err instanceof Timeout ? 'handshake timeout' : err instanceof Error ? err.message : String(err);
      throw this.error('tls', undefined, text);
    }
    await this.ehlo();
  }

  private async authenticate(): Promise<void> {
    const mechanisms = (this.capabilities.get('AUTH') ?? '').toUpperCase().split(/\s+/).filter(Boolean);
    const { username, auth } = this.account;
    const fail = (reply: Reply) => this.error('auth', reply);
    const expect = (reply: Reply, code: number) => {
      if (reply.code !== code) throw fail(reply);
    };

    if (auth.kind === 'oauth2') {
      if (!mechanisms.includes('XOAUTH2')) throw this.error('auth', undefined, 'server offers no XOAUTH2');
      const blob = base64(encoder.encode(`user=${username}\u0001auth=Bearer ${auth.accessToken}\u0001\u0001`));
      this.secrets.push(blob);
      let reply = await this.command(`AUTH XOAUTH2 ${blob}`);
      if (reply.code === 334) reply = await this.command(''); // the error JSON is answered with an empty line
      expect(reply, 235);
      return;
    }

    if (mechanisms.includes('PLAIN')) {
      const blob = base64(encoder.encode(`\u0000${username}\u0000${auth.password}`));
      this.secrets.push(blob);
      expect(await this.command(`AUTH PLAIN ${blob}`), 235);
    } else if (mechanisms.includes('LOGIN')) {
      expect(await this.command('AUTH LOGIN'), 334);
      expect(await this.command(base64(encoder.encode(username))), 334);
      expect(await this.command(base64(encoder.encode(auth.password))), 235);
    } else {
      throw this.error('auth', undefined, 'server offers no PLAIN or LOGIN');
    }
  }

  /** Connect, greet, upgrade if the account says so, and log in. */
  async start(open: MailEndpointOpener, authenticate: boolean): Promise<void> {
    const { host, port, security, tls } = this.account;
    const endpoint: MailEndpoint = { host, port, tls: security === 'tls' ? 'implicit' : 'none' };
    if (tls?.ca !== undefined) endpoint.ca = tls.ca;
    try {
      this.stream = await within(open(endpoint), this.timeoutMs);
    } catch (err) {
      throw this.transportError(err);
    }
    this.reader = new ByteReader(this.stream);

    const greeting = await this.reply();
    if (greeting.code !== 220) throw this.error('connect', greeting);
    await this.ehlo();
    if (security === 'starttls') await this.upgrade();
    if (authenticate) await this.authenticate();
  }

  async deliver(envelope: Envelope, raw: Uint8Array): Promise<WireResult> {
    for (const address of [envelope.from, ...envelope.to]) {
      if (ENVELOPE_UNSAFE.test(address)) throw new SmtpError('config', 'envelope address contains a forbidden character');
    }
    const from = await this.command(`MAIL FROM:<${envelope.from}>`);
    if (from.code !== 250) throw this.error(from.code === 421 ? 'connect' : 'rejected', from);

    const accepted: string[] = [];
    const rejected: string[] = [];
    let lastRefusal: Reply | undefined;
    for (const address of envelope.to) {
      const reply = await this.command(`RCPT TO:<${address}>`);
      if (reply.code === 250 || reply.code === 251) accepted.push(address);
      else if (reply.code === 421) throw this.error('connect', reply);
      else {
        rejected.push(address);
        lastRefusal = reply;
      }
    }
    if (accepted.length === 0) throw this.error('rejected', lastRefusal);

    const go = await this.command('DATA');
    if (go.code !== 354) throw this.error(go.code === 421 ? 'connect' : 'rejected', go);
    await this.send(prepareData(raw));
    const done = await this.reply();
    if (done.code !== 250) throw this.error(done.code === 421 ? 'connect' : 'rejected', done);
    return { accepted, rejected, response: scrub(done.lines.join(' '), this.secrets) };
  }

  /** Best effort: a peer that is gone already must not turn a sent message into an error. */
  async end(): Promise<void> {
    const stream = this.stream;
    if (!stream) return;
    try {
      await within(this.command('QUIT'), QUIT_TIMEOUT_MS);
    } catch {
      // ignore
    }
    try {
      await stream.close();
    } catch {
      // ignore
    }
    this.stream = null;
  }
}

function checked(account: SmtpAccount): void {
  validateAccount(account);
  if (account.tls?.rejectUnauthorized === false) {
    throw new SmtpError('config', 'tls.rejectUnauthorized: false is not supported by the wire client');
  }
}

/** Connect and log in, then hang up: sends nothing. Throws an SmtpError on any failure. */
export async function verifyOverWire(
  account: SmtpAccount,
  open: MailEndpointOpener,
  options: WireOptions = {},
): Promise<void> {
  checked(account);
  const session = new Session(account, options);
  try {
    await session.start(open, true);
  } finally {
    await session.end();
  }
}

/** Send `raw` (RFC 5322 bytes, any line endings) to the envelope's recipients. */
export async function sendOverWire(
  account: SmtpAccount,
  envelope: Envelope,
  raw: Uint8Array,
  open: MailEndpointOpener,
  options: WireOptions = {},
): Promise<WireResult> {
  checked(account);
  const session = new Session(account, options);
  try {
    await session.start(open, true);
    return await session.deliver(envelope, raw);
  } finally {
    await session.end();
  }
}
