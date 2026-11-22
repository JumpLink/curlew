import { describe, expect, it } from '@gjsify/unit';

import type { UpgradableByteStream } from '@curlew/protocol';
import { prepareData, sendOverWire, SmtpError, verifyOverWire } from '@curlew/smtp/wire';
import type { SmtpAccount } from '@curlew/smtp/wire';

// Synthetic only: a fake server behind the ByteStream port, no socket.
const PASSWORD = 'SECRET-pa55w0rd-for-tests';
const TOKEN = 'SECRET-token-for-tests';

interface FakeOptions {
  /** Server answers per verb; a function sees the whole command line. Default replies below. */
  replies?: Record<string, string | ((line: string) => string)>;
  ehlo?: string;
  /** Skip the greeting: the server stays silent. */
  silent?: boolean;
  /** Reject `upgradeTls` with this message. */
  tlsFails?: string;
  /** Bytes the server sends right after the STARTTLS 220, in the same chunk. */
  injectAfterStarttls?: string;
  greeting?: string;
}

/** A server double: parses the client's writes into commands and DATA payloads and answers. */
class FakeServer implements UpgradableByteStream {
  readonly commands: string[] = [];
  readonly payloads: string[] = [];
  upgraded = 0;
  closed = 0;
  private buffer = '';
  private inData = false;
  private readonly pending: Uint8Array[] = [];
  private waiting: ((chunk: Uint8Array) => void) | null = null;
  private readonly options: FakeOptions;

  constructor(options: FakeOptions = {}) {
    this.options = options;
    if (!options.silent) this.push(options.greeting ?? '220 fake ESMTP\r\n');
  }

  private push(text: string): void {
    const chunk = Uint8Array.from(text, (c) => c.charCodeAt(0));
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(chunk);
    } else this.pending.push(chunk);
  }

  async read(max: number): Promise<Uint8Array> {
    if (this.closed > 0) return new Uint8Array(0);
    const head = this.pending.shift();
    if (head === undefined) return new Promise((resolve) => (this.waiting = resolve));
    if (head.length <= max) return head;
    this.pending.unshift(head.subarray(max));
    return head.subarray(0, max);
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.buffer += Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    for (;;) {
      if (this.inData) {
        const end = this.buffer.indexOf('\r\n.\r\n');
        if (end === -1) return;
        this.payloads.push(this.buffer.slice(0, end + 2));
        this.buffer = this.buffer.slice(end + 5);
        this.inData = false;
        this.push(this.answer('.DONE', '250 2.0.0 queued as 1\r\n'));
        continue;
      }
      const eol = this.buffer.indexOf('\r\n');
      if (eol === -1) return;
      const line = this.buffer.slice(0, eol);
      this.buffer = this.buffer.slice(eol + 2);
      this.commands.push(line);
      this.command(line);
    }
  }

  private answer(key: string, fallback: string, line = key): string {
    const custom = this.options.replies?.[key];
    if (custom === undefined) return fallback;
    return typeof custom === 'function' ? custom(line) : custom;
  }

  private command(line: string): void {
    const verb = line.split(' ')[0].toUpperCase();
    if (verb === 'EHLO') {
      this.push(
        this.answer(
          'EHLO',
          this.options.ehlo ?? '250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n',
          line,
        ),
      );
    } else if (verb === 'STARTTLS') {
      this.push(this.answer('STARTTLS', '220 go ahead\r\n') + (this.options.injectAfterStarttls ?? ''));
    } else if (verb === 'MAIL' || verb === 'RCPT' || verb === 'HELO') {
      this.push(this.answer(verb, '250 ok\r\n', line));
    } else if (verb === 'AUTH') {
      this.push(this.answer('AUTH', '235 2.7.0 ok\r\n', line));
    } else if (verb === 'DATA') {
      const reply = this.answer('DATA', '354 go ahead\r\n');
      this.inData = reply.startsWith('354');
      this.push(reply);
    } else if (verb === 'QUIT') {
      this.push('221 bye\r\n');
    } else {
      // A LOGIN step: the base64 name, the base64 password, or an empty line.
      this.push(this.answer('STEP', '235 ok\r\n', line));
    }
  }

  async upgradeTls(): Promise<void> {
    if (this.options.tlsFails) throw new Error(this.options.tlsFails);
    this.upgraded++;
  }

  async close(): Promise<void> {
    this.closed++;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(new Uint8Array(0));
    }
  }
}

const accountOf = (overrides: Partial<SmtpAccount> = {}): SmtpAccount => ({
  host: 'smtp.example.invalid',
  port: 587,
  security: 'starttls',
  username: 'user@example.invalid',
  auth: { kind: 'password', password: PASSWORD },
  ...overrides,
});

const ENVELOPE = { from: 'sender@example.invalid', to: ['a@example.invalid', 'b@example.invalid'] };
const RAW = new TextEncoder().encode('Subject: hi\n\nhello\n');
const b64 = (text: string) => btoa(text);
const text = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');

async function failure(run: () => Promise<unknown>): Promise<SmtpError> {
  try {
    await run();
  } catch (err) {
    expect(err instanceof SmtpError).toBe(true);
    return err as SmtpError;
  }
  throw new Error('expected an SmtpError');
}

const STARTTLS_EHLO = '250-fake\r\n250-STARTTLS\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n';

export default async () => {
  await describe('prepareData', async () => {
    await it('normalises line endings, stuffs dots and terminates', async () => {
      expect(text(prepareData(new TextEncoder().encode('a\nb\r\nc\r.d\n.e\n..f')))).toBe(
        'a\r\nb\r\nc\r\n..d\r\n..e\r\n...f\r\n.\r\n',
      );
    });
    await it('does not add a blank line when the message ends in CRLF', async () => {
      expect(text(prepareData(new TextEncoder().encode('x\r\n')))).toBe('x\r\n.\r\n');
    });
    await it('handles an empty message and leaves non-ASCII bytes alone', async () => {
      expect(text(prepareData(new Uint8Array(0)))).toBe('.\r\n');
      expect(Array.from(prepareData(Uint8Array.from([0xc3, 0xa4])))).toStrictEqual([
        0xc3, 0xa4, 13, 10, 46, 13, 10,
      ]);
    });
  });

  await describe('SMTP wire client over a fake ByteStream', async () => {
    const opener = (server: FakeServer) => async () => server;

    await it('sends over implicit TLS: EHLO, AUTH PLAIN, envelope, DATA, QUIT', async () => {
      const server = new FakeServer();
      const result = await sendOverWire(
        accountOf({ security: 'tls', port: 465 }),
        ENVELOPE,
        RAW,
        opener(server),
      );
      expect(server.commands).toStrictEqual([
        'EHLO localhost',
        `AUTH PLAIN ${b64(`\u0000user@example.invalid\u0000${PASSWORD}`)}`,
        'MAIL FROM:<sender@example.invalid>',
        'RCPT TO:<a@example.invalid>',
        'RCPT TO:<b@example.invalid>',
        'DATA',
        'QUIT',
      ]);
      expect(server.payloads).toStrictEqual(['Subject: hi\r\n\r\nhello\r\n']);
      expect(result.accepted).toStrictEqual(ENVELOPE.to);
      expect(result.rejected).toStrictEqual([]);
      expect(result.response).toBe('2.0.0 queued as 1');
      expect(server.upgraded).toBe(0);
      expect(server.closed).toBe(1);
    });

    await it('passes the endpoint: implicit for tls, plain otherwise, with the CA', async () => {
      const seen: unknown[] = [];
      const open = async (endpoint: unknown) => {
        seen.push(endpoint);
        return new FakeServer();
      };
      await verifyOverWire(accountOf({ security: 'tls', port: 465, tls: { ca: 'PEM' } }), open);
      await verifyOverWire(accountOf({ security: 'none', host: '127.0.0.1', port: 25 }), open);
      expect(seen).toStrictEqual([
        { host: 'smtp.example.invalid', port: 465, tls: 'implicit', ca: 'PEM' },
        { host: '127.0.0.1', port: 25, tls: 'none' },
      ]);
    });

    await it('upgrades on STARTTLS and says EHLO again before AUTH', async () => {
      const server = new FakeServer({ ehlo: STARTTLS_EHLO });
      await verifyOverWire(accountOf(), opener(server));
      expect(server.commands.slice(0, 4)).toStrictEqual([
        'EHLO localhost',
        'STARTTLS',
        'EHLO localhost',
        `AUTH PLAIN ${b64(`\u0000user@example.invalid\u0000${PASSWORD}`)}`,
      ]);
      expect(server.upgraded).toBe(1);
      expect(server.commands.some((c) => c.startsWith('MAIL'))).toBe(false);
    });

    await it('a server that does not offer STARTTLS is a tls error, and no AUTH is sent', async () => {
      const server = new FakeServer();
      const err = await failure(() => verifyOverWire(accountOf(), opener(server)));
      expect(err.code).toBe('tls');
      expect(server.commands.some((c) => c.startsWith('AUTH'))).toBe(false);
    });

    await it('refused STARTTLS (454) is a tls error with the reply code', async () => {
      const server = new FakeServer({
        ehlo: STARTTLS_EHLO,
        replies: { STARTTLS: '454 TLS not available\r\n' },
      });
      const err = await failure(() => verifyOverWire(accountOf(), opener(server)));
      expect(err.code).toBe('tls');
      expect(err.responseCode).toBe(454);
      expect(server.upgraded).toBe(0);
    });

    await it('a failed handshake is a tls error and the stream is closed', async () => {
      const server = new FakeServer({ ehlo: STARTTLS_EHLO, tlsFails: 'self-signed certificate' });
      const err = await failure(() => verifyOverWire(accountOf(), opener(server)));
      expect(err.code).toBe('tls');
      expect(err.detail).toBe('self-signed certificate');
      expect(server.closed).toBe(1);
      expect(server.commands.some((c) => c.startsWith('AUTH'))).toBe(false);
    });

    await it('plaintext injected after the 220 rejects the upgrade (STARTTLS injection)', async () => {
      const server = new FakeServer({ ehlo: STARTTLS_EHLO, injectAfterStarttls: '250 evil\r\n' });
      const err = await failure(() => verifyOverWire(accountOf(), opener(server)));
      expect(err.code).toBe('tls');
      expect(server.upgraded).toBe(0);
    });

    await it('falls back to HELO when EHLO is not understood', async () => {
      const server = new FakeServer({
        replies: { EHLO: '502 5.5.1 unrecognised\r\n', HELO: '250 hello\r\n' },
      });
      const err = await failure(() => verifyOverWire(accountOf({ security: 'tls' }), opener(server)));
      expect(server.commands.slice(0, 2)).toStrictEqual(['EHLO localhost', 'HELO localhost']);
      expect(err.code).toBe('auth'); // HELO carries no AUTH capability
    });

    await it('uses AUTH LOGIN when PLAIN is not offered', async () => {
      const server = new FakeServer({
        ehlo: '250-fake\r\n250 AUTH LOGIN\r\n',
        replies: {
          AUTH: '334 VXNlcm5hbWU6\r\n',
          STEP: (line) => (line === b64('user@example.invalid') ? '334 UGFzc3dvcmQ6\r\n' : '235 ok\r\n'),
        },
      });
      await verifyOverWire(accountOf({ security: 'tls' }), opener(server));
      expect(server.commands.slice(1, 4)).toStrictEqual([
        'AUTH LOGIN',
        b64('user@example.invalid'),
        b64(PASSWORD),
      ]);
    });

    await it('uses XOAUTH2 for a token and answers the error challenge', async () => {
      const server = new FakeServer({
        ehlo: '250-fake\r\n250 AUTH XOAUTH2\r\n',
        replies: { AUTH: '334 eyJzdGF0dXMiOiI0MDAifQ==\r\n', STEP: '535 5.7.8 bad token\r\n' },
      });
      const err = await failure(() =>
        verifyOverWire(
          accountOf({ security: 'tls', auth: { kind: 'oauth2', accessToken: TOKEN } }),
          opener(server),
        ),
      );
      expect(err.code).toBe('auth');
      expect(err.responseCode).toBe(535);
      expect(server.commands[1].startsWith('AUTH XOAUTH2 ')).toBe(true);
      expect(server.commands[2]).toBe('');
    });

    await it('maps 535 to auth and never lets the secret into the error', async () => {
      const server = new FakeServer({ replies: { AUTH: `535 5.7.8 rejected ${PASSWORD}\r\n` } });
      const err = await failure(() => verifyOverWire(accountOf({ security: 'tls' }), opener(server)));
      expect(err.code).toBe('auth');
      expect(err.responseCode).toBe(535);
      expect(`${err.message} ${err.detail ?? ''}`.includes(PASSWORD)).toBe(false);
      expect(err.message.includes('[redacted]')).toBe(true);
    });

    await it('refuses AUTH when the server offers no usable mechanism', async () => {
      const server = new FakeServer({ ehlo: '250-fake\r\n250 AUTH CRAM-MD5\r\n' });
      const err = await failure(() => verifyOverWire(accountOf({ security: 'tls' }), opener(server)));
      expect(err.code).toBe('auth');
      expect(server.commands.length).toBe(2); // EHLO, QUIT
    });

    await it('reads a multi-line reply and parses capabilities case-insensitively', async () => {
      const server = new FakeServer({
        ehlo: '250-fake\r\n250-auth plain\r\n250-SIZE 100\r\n250 ENHANCEDSTATUSCODES\r\n',
      });
      await verifyOverWire(accountOf({ security: 'tls' }), opener(server));
      expect(server.commands[1].startsWith('AUTH PLAIN')).toBe(true);
    });

    await it('a reply that is not SMTP is a connect error', async () => {
      const server = new FakeServer({ greeting: '* OK this is IMAP\r\n' });
      const err = await failure(() => verifyOverWire(accountOf({ security: 'tls' }), opener(server)));
      expect(err.code).toBe('connect');
    });

    await it('a changing code inside a multi-line reply is a connect error', async () => {
      const server = new FakeServer({ ehlo: '250-fake\r\n251 mixed\r\n' });
      const err = await failure(() => verifyOverWire(accountOf({ security: 'tls' }), opener(server)));
      expect(err.code).toBe('connect');
    });

    await it('a greeting other than 220 (554) is a connect error with the code', async () => {
      const server = new FakeServer({ greeting: '554 no service\r\n' });
      const err = await failure(() => verifyOverWire(accountOf({ security: 'tls' }), opener(server)));
      expect(err.code).toBe('connect');
      expect(err.responseCode).toBe(554);
    });

    await it('a connection that ends mid-dialogue is a connect error', async () => {
      const server = new FakeServer();
      const dying = {
        read: (max: number) =>
          server.commands.length >= 1 ? Promise.resolve(new Uint8Array(0)) : server.read(max),
        write: (b: Uint8Array) => server.write(b),
        close: () => server.close(),
        upgradeTls: () => server.upgradeTls(),
      };
      const err = await failure(() => verifyOverWire(accountOf({ security: 'tls' }), async () => dying));
      expect(err.code).toBe('connect');
    });

    await it('a silent server ends as a connect error at the timeout, not a hang', async () => {
      const server = new FakeServer({ silent: true });
      const err = await failure(() =>
        verifyOverWire(accountOf({ security: 'tls' }), opener(server), { timeoutMs: 30 }),
      );
      expect(err.code).toBe('connect');
      expect(err.detail).toBe('timeout');
      expect(server.closed).toBe(1);
    });

    await it('an opener that rejects is a connect error; a certificate text is tls', async () => {
      const refused = await failure(() =>
        verifyOverWire(accountOf({ security: 'tls' }), async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:465');
        }),
      );
      expect(refused.code).toBe('connect');
      const cert = await failure(() =>
        verifyOverWire(accountOf({ security: 'tls' }), async () => {
          throw new Error('self-signed certificate');
        }),
      );
      expect(cert.code).toBe('tls');
    });

    await it('maps a partially rejected recipient list and reports it', async () => {
      const server = new FakeServer({
        replies: { RCPT: (line) => (line.includes('b@') ? '550 5.1.1 no such user\r\n' : '250 ok\r\n') },
      });
      const result = await sendOverWire(accountOf({ security: 'tls' }), ENVELOPE, RAW, opener(server));
      expect(result.accepted).toStrictEqual(['a@example.invalid']);
      expect(result.rejected).toStrictEqual(['b@example.invalid']);
    });

    await it('all recipients refused is rejected, and DATA is never sent', async () => {
      const server = new FakeServer({ replies: { RCPT: '550 5.1.1 no such user\r\n' } });
      const err = await failure(() =>
        sendOverWire(accountOf({ security: 'tls' }), ENVELOPE, RAW, opener(server)),
      );
      expect(err.code).toBe('rejected');
      expect(err.responseCode).toBe(550);
      expect(server.commands.includes('DATA')).toBe(false);
    });

    await it('a refused sender is rejected; 421 is a dropped connection', async () => {
      const refused = await failure(() =>
        sendOverWire(
          accountOf({ security: 'tls' }),
          ENVELOPE,
          RAW,
          opener(new FakeServer({ replies: { MAIL: '553 5.7.1 sender not allowed\r\n' } })),
        ),
      );
      expect(refused.code).toBe('rejected');
      const gone = await failure(() =>
        sendOverWire(
          accountOf({ security: 'tls' }),
          ENVELOPE,
          RAW,
          opener(new FakeServer({ replies: { MAIL: '421 4.3.2 shutting down\r\n' } })),
        ),
      );
      expect(gone.code).toBe('connect');
    });

    await it('a refused message after DATA is rejected with the reply code', async () => {
      const server = new FakeServer({ replies: { '.DONE': '554 5.7.1 spam\r\n' } });
      const err = await failure(() =>
        sendOverWire(accountOf({ security: 'tls' }), ENVELOPE, RAW, opener(server)),
      );
      expect(err.code).toBe('rejected');
      expect(err.responseCode).toBe(554);
    });

    await it('a refused DATA command is rejected', async () => {
      const server = new FakeServer({ replies: { DATA: '503 5.5.1 bad sequence\r\n' } });
      const err = await failure(() =>
        sendOverWire(accountOf({ security: 'tls' }), ENVELOPE, RAW, opener(server)),
      );
      expect(err.code).toBe('rejected');
    });

    await it('dot-stuffs the body on the wire', async () => {
      const server = new FakeServer();
      await sendOverWire(
        accountOf({ security: 'tls' }),
        ENVELOPE,
        new TextEncoder().encode('Subject: x\r\n\r\n.hidden\r\n.\r\nafter\r\n'),
        opener(server),
      );
      expect(server.payloads).toStrictEqual(['Subject: x\r\n\r\n..hidden\r\n..\r\nafter\r\n']);
    });

    await it('refuses an envelope address with a line break before anything is sent', async () => {
      const server = new FakeServer();
      const err = await failure(() =>
        sendOverWire(
          accountOf({ security: 'tls' }),
          { from: 'a@example.invalid', to: ['x@example.invalid>\r\nRCPT TO:<y@example.invalid'] },
          RAW,
          opener(server),
        ),
      );
      expect(err.code).toBe('config');
      expect(server.commands.some((c) => c.startsWith('MAIL'))).toBe(false);
    });

    await it('validates the account and refuses rejectUnauthorized:false without connecting', async () => {
      let opened = 0;
      const open = async () => {
        opened++;
        return new FakeServer();
      };
      const bad = await failure(() => verifyOverWire(accountOf({ port: 0 }), open));
      expect(bad.code).toBe('config');
      const insecure = await failure(() =>
        verifyOverWire(accountOf({ security: 'tls', tls: { rejectUnauthorized: false } }), open),
      );
      expect(insecure.code).toBe('config');
      expect(opened).toBe(0);
    });

    await it('verify sends no MAIL FROM, and QUIT against a dead peer does not throw', async () => {
      const server = new FakeServer({ replies: {} });
      const closing = {
        read: (max: number) => server.read(max),
        write: async (b: Uint8Array) => {
          if (text(b).startsWith('QUIT')) throw new Error('broken pipe');
          return server.write(b);
        },
        close: () => server.close(),
        upgradeTls: () => server.upgradeTls(),
      };
      await verifyOverWire(accountOf({ security: 'tls' }), async () => closing);
      expect(server.commands.some((c) => c.startsWith('MAIL'))).toBe(false);
      expect(server.closed).toBe(1);
    });
  });
};
