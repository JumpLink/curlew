import { describe, expect, it } from '@gjsify/unit';

import { sendMessage, SmtpError, verifyAccount } from '@curlew/smtp';
import type { OutgoingMessage, SmtpAccount } from '@curlew/smtp';

import { startDummyServer } from './dummy-server.ts';
import type { DummyOptions } from './dummy-server.ts';

// Synthetic only: a server on 127.0.0.1 that is created and closed inside each case, a recipient
// on example.invalid, and secrets that are conspicuous so a leak is found by `includes`.
const PASSWORD = 'SECRET-pa55w0rd-for-tests';
const TOKEN = 'SECRET-token-for-tests';

const MESSAGE: OutgoingMessage = {
  from: 'sender@example.invalid',
  to: ['test@example.invalid'],
  subject: 'Rechnung für Köln',
  text: 'Anbei die Datei.\n',
  attachments: [
    {
      filename: 'one.bin',
      content: Uint8Array.from([0, 1, 2, 253, 254, 255]),
      contentType: 'application/octet-stream',
    },
    { filename: 'two.txt', content: new TextEncoder().encode('zwei\n'), contentType: 'text/plain' },
  ],
};

function accountFor(
  port: number,
  auth: SmtpAccount['auth'] = { kind: 'password', password: PASSWORD },
): SmtpAccount {
  return { host: '127.0.0.1', port, security: 'none', username: 'user@example.invalid', auth };
}

/** Runs `body` against a fresh dummy server and always closes it. */
async function withServer<T>(
  options: DummyOptions,
  body: (server: Awaited<ReturnType<typeof startDummyServer>>) => Promise<T>,
): Promise<T> {
  const server = await startDummyServer(options);
  try {
    return await body(server);
  } finally {
    await server.close();
  }
}

async function failure(run: () => Promise<unknown>): Promise<SmtpError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof SmtpError) return err;
    throw err;
  }
  throw new Error('expected an SmtpError, the call succeeded');
}

/** Everything of an error a caller or a log could print. */
function surface(err: SmtpError): string {
  return [err.message, err.stack ?? '', String(err), JSON.stringify(err), JSON.stringify({ ...err })].join(
    '\n',
  );
}

const b64 = (text: string) => btoa(text);

export default async () => {
  await describe('verifyAccount against a local dummy server', async () => {
    await it('logs in with AUTH PLAIN and sends nothing', async () => {
      await withServer({}, async (server) => {
        await verifyAccount(accountFor(server.port));
        const { commands } = server.dialogue;
        const auth = commands.find((line) => line.startsWith('AUTH PLAIN '));
        expect(auth !== undefined).toBe(true);
        expect(atob(auth!.slice('AUTH PLAIN '.length))).toBe(`\0user@example.invalid\0${PASSWORD}`);
        // The point of verify: the login is tested, the sender and the recipients are not touched.
        expect(commands.some((line) => /^(MAIL|RCPT|DATA)/i.test(line))).toBe(false);
        expect(server.dialogue.messages.length).toBe(0);
      });
    });

    await it('tells a refused login from a bad connection, and keeps the secret out', async () => {
      await withServer({ rejectAuthEchoing: `${PASSWORD} ${b64(PASSWORD)}` }, async (server) => {
        const err = await failure(() => verifyAccount(accountFor(server.port)));
        expect(err.code).toBe('auth');
        expect(err.responseCode).toBe(535);
        expect(surface(err).includes(PASSWORD)).toBe(false);
        expect(surface(err).includes(b64(PASSWORD))).toBe(false);
      });
    });

    await it('reports a closed port as connect', async () => {
      const port = await withServer({}, async (server) => server.port);
      const err = await failure(() => verifyAccount(accountFor(port)));
      expect(err.code).toBe('connect');
      expect(surface(err).includes(PASSWORD)).toBe(false);
    });
  });

  await describe('sendMessage against a local dummy server', async () => {
    await it('delivers the message with both attachments', async () => {
      await withServer({}, async (server) => {
        const result = await sendMessage(accountFor(server.port), MESSAGE);

        expect(result.accepted.join(',')).toBe('test@example.invalid');
        expect(result.rejected.length).toBe(0);
        expect(/^<[0-9a-f]{32}@example\.invalid>$/.test(result.messageId)).toBe(true);

        const { commands, messages } = server.dialogue;
        expect(commands.some((line) => line.startsWith('AUTH PLAIN '))).toBe(true);
        expect(commands.includes('MAIL FROM:<sender@example.invalid>')).toBe(true);
        expect(commands.includes('RCPT TO:<test@example.invalid>')).toBe(true);
        expect(messages.length).toBe(1);

        const raw = messages[0];
        expect(raw.includes(`Message-ID: ${result.messageId}`)).toBe(true);
        const boundary = /boundary="([^"]+)"/.exec(raw)![1];
        // A multipart/mixed with the text and two attachments is three parts.
        expect(raw.split(`\r\n--${boundary}\r\n`).length - 1).toBe(3);
        expect(raw.includes('Content-Disposition: attachment; filename=one.bin')).toBe(true);
        expect(raw.includes('Content-Disposition: attachment; filename=two.txt')).toBe(true);
        expect(raw.includes('AAEC/f7/')).toBe(true);
        expect(raw.includes(b64('zwei\n'))).toBe(true);
        expect(raw.includes(PASSWORD)).toBe(false);
        expect(JSON.stringify(result).includes(PASSWORD)).toBe(false);
      });
    });

    await it('logs in with XOAUTH2 when given an access token', async () => {
      await withServer({}, async (server) => {
        await sendMessage(accountFor(server.port, { kind: 'oauth2', accessToken: TOKEN }), MESSAGE);
        const auth = server.dialogue.commands.find((line) => line.startsWith('AUTH XOAUTH2 '));
        expect(auth !== undefined).toBe(true);
        expect(atob(auth!.slice('AUTH XOAUTH2 '.length))).toBe(
          `user=user@example.invalid\x01auth=Bearer ${TOKEN}\x01\x01`,
        );
      });
    });

    await it('reports the recipients the server refused, and still sends to the others', async () => {
      await withServer({ rejectRecipients: ['gone@example.invalid'] }, async (server) => {
        const result = await sendMessage(accountFor(server.port), {
          ...MESSAGE,
          to: ['test@example.invalid', 'gone@example.invalid'],
        });
        expect(result.accepted.join(',')).toBe('test@example.invalid');
        expect(result.rejected.join(',')).toBe('gone@example.invalid');
        expect(server.dialogue.messages.length).toBe(1);
      });
    });

    await it('throws rejected, and sends no data, when no recipient is accepted', async () => {
      await withServer({ rejectRecipients: ['test@example.invalid'] }, async (server) => {
        const err = await failure(() => sendMessage(accountFor(server.port), MESSAGE));
        expect(err.code).toBe('rejected');
        expect(server.dialogue.messages.length).toBe(0);
        expect(surface(err).includes(PASSWORD)).toBe(false);
      });
    });

    await it('refuses a login before it sends anything', async () => {
      await withServer({ rejectAuthEchoing: PASSWORD }, async (server) => {
        const err = await failure(() => sendMessage(accountFor(server.port), MESSAGE));
        expect(err.code).toBe('auth');
        expect(surface(err).includes(PASSWORD)).toBe(false);
        expect(server.dialogue.commands.some((line) => /^MAIL/i.test(line))).toBe(false);
      });
    });
  });

  await describe('secrets in errors', async () => {
    await it('never reach a config error, whatever is wrong', async () => {
      const remote = { host: 'mail.example.invalid', port: 25, security: 'none' as const };
      const cases: Array<() => Promise<unknown>> = [
        () => verifyAccount({ ...accountFor(1), ...remote }),
        () => verifyAccount({ ...accountFor(1), port: 0 }),
        () => sendMessage({ ...accountFor(1), ...remote }, MESSAGE),
        () => sendMessage(accountFor(1), { ...MESSAGE, subject: `a\r\nBcc: ${PASSWORD}@example.invalid` }),
        () => sendMessage(accountFor(1, { kind: 'oauth2', accessToken: TOKEN }), { ...MESSAGE, to: [] }),
        () => verifyAccount({ ...accountFor(1, { kind: 'oauth2', accessToken: TOKEN }), ...remote }),
      ];
      for (const run of cases) {
        const err = await failure(run);
        expect(err.code).toBe('config');
        expect(surface(err).includes(PASSWORD)).toBe(false);
        expect(surface(err).includes(TOKEN)).toBe(false);
      }
    });
  });

  // TLS and STARTTLS against a real TLS server need gjsify#2071 (peer verification after the
  // handshake, and the socket under a TLS connection), which is not released. Nothing here may be
  // faked in curlew, so the cases wait for the release; see packages/smtp/README.md.
  await describe('TLS (waits for gjsify#2071)', async () => {
    await it.skip('connects with security tls to a server with a self-signed certificate and tls.ca', async () => {});
    await it.skip('upgrades with security starttls, and fails with tls when the upgrade is refused', async () => {});
    await it.skip('fails with tls for a certificate the tls.ca does not cover', async () => {});
  });
};
