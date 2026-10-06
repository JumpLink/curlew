import { describe, expect, it } from '@gjsify/unit';

import { decodeRfc2047 } from '@curlew/protocol';
import { buildMessage, SmtpError, validateAccount, validateMessage } from '@curlew/smtp';
import type { OutgoingMessage, SmtpAccount } from '@curlew/smtp';

// Synthetic only: example.invalid never resolves, so nothing here can reach a person.
const MESSAGE: OutgoingMessage = {
  from: 'sender@example.invalid',
  to: ['test@example.invalid'],
  subject: 'Grüße aus Köln',
  text: 'Hallo\n',
};

const ACCOUNT: SmtpAccount = {
  host: '127.0.0.1',
  port: 2525,
  security: 'none',
  username: 'user',
  auth: { kind: 'password', password: 'dummy-password' },
};

const decode = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

/** The code of the SmtpError a call throws; anything else is a failure of the test. */
async function codeOf(run: () => unknown): Promise<string | undefined> {
  try {
    await run();
  } catch (err) {
    return err instanceof SmtpError ? err.code : `not an SmtpError: ${String(err)}`;
  }
  return undefined;
}

export default async () => {
  await describe('buildMessage', async () => {
    await it('encodes a subject with umlauts per RFC 2047', async () => {
      const raw = decode(await buildMessage(MESSAGE));
      const line = /^Subject: (=\?UTF-8\?[BQ]\?.+\?=)\r?$/m.exec(raw);
      expect(line !== null).toBe(true);
      expect(raw.includes('Grüße')).toBe(false);
      expect(decodeRfc2047(line![1])).toBe('Grüße aus Köln');
    });

    await it('carries an attachment as base64, byte for byte', async () => {
      const content = Uint8Array.from({ length: 256 }, (_, i) => i);
      const raw = decode(
        await buildMessage({
          ...MESSAGE,
          attachments: [{ filename: 'bytes.bin', content, contentType: 'application/octet-stream' }],
        }),
      );
      expect(/^Content-Type: multipart\/mixed;/m.test(raw)).toBe(true);
      expect(/^Content-Type: application\/octet-stream; name=bytes\.bin\r?$/m.test(raw)).toBe(true);
      expect(/^Content-Disposition: attachment; filename=bytes\.bin\r?$/m.test(raw)).toBe(true);
      expect(/^Content-Transfer-Encoding: base64\r?$/m.test(raw)).toBe(true);

      const part = /^Content-Disposition: attachment; filename=bytes\.bin\r?\n\r?\n([\s\S]*?)\r?\n--/m.exec(
        raw,
      );
      expect(part !== null).toBe(true);
      const decoded = Uint8Array.from(atob(part![1].replace(/\s+/g, '')), (c) => c.charCodeAt(0));
      expect(decoded.join(',')).toBe(content.join(','));
    });

    await it('adds a html alternative next to the text', async () => {
      const raw = decode(await buildMessage({ ...MESSAGE, html: '<p>Hallo</p>' }));
      expect(/^Content-Type: multipart\/alternative;/m.test(raw)).toBe(true);
      expect(raw.includes('text/plain')).toBe(true);
      expect(raw.includes('text/html')).toBe(true);
    });

    await it('generates a Message-ID on the domain of the sender, and a fresh one each time', async () => {
      const first = /^Message-ID: (<[0-9a-f]{32}@example\.invalid>)\r?$/m.exec(
        decode(await buildMessage(MESSAGE)),
      );
      const second = /^Message-ID: (<[0-9a-f]{32}@example\.invalid>)\r?$/m.exec(
        decode(await buildMessage(MESSAGE)),
      );
      expect(first !== null && second !== null).toBe(true);
      expect(first![1] === second![1]).toBe(false);
    });

    await it('keeps a Message-ID the caller gave', async () => {
      const raw = decode(await buildMessage({ ...MESSAGE, messageId: '<fixed-1@example.invalid>' }));
      expect(/^Message-ID: <fixed-1@example\.invalid>\r?$/m.test(raw)).toBe(true);
    });

    await it('lists cc and does not leak an unrelated header', async () => {
      const raw = decode(await buildMessage({ ...MESSAGE, cc: ['copy@example.invalid'] }));
      expect(/^Cc: copy@example\.invalid\r?$/m.test(raw)).toBe(true);
      expect(/^Bcc:/im.test(raw)).toBe(false);
    });
  });

  await describe('message validation — header injection', async () => {
    const INJECTION = 'x\r\nBcc: evil@example.invalid';

    await it('rejects a line break in the subject', async () => {
      expect(await codeOf(() => buildMessage({ ...MESSAGE, subject: INJECTION }))).toBe('config');
      expect(await codeOf(() => buildMessage({ ...MESSAGE, subject: 'a\nb' }))).toBe('config');
      expect(await codeOf(() => buildMessage({ ...MESSAGE, subject: 'a\rb' }))).toBe('config');
    });

    await it('rejects a line break in from, to and cc', async () => {
      const bad = `a@example.invalid${INJECTION}`;
      expect(await codeOf(() => buildMessage({ ...MESSAGE, from: bad }))).toBe('config');
      expect(await codeOf(() => buildMessage({ ...MESSAGE, to: [bad] }))).toBe('config');
      expect(await codeOf(() => buildMessage({ ...MESSAGE, cc: [bad] }))).toBe('config');
    });

    await it('rejects a line break in a filename, a content type and a Message-ID', async () => {
      const content = new Uint8Array([1]);
      expect(
        await codeOf(() => buildMessage({ ...MESSAGE, attachments: [{ filename: INJECTION, content }] })),
      ).toBe('config');
      expect(
        await codeOf(() =>
          buildMessage({
            ...MESSAGE,
            attachments: [{ filename: 'a.bin', content, contentType: `text/plain${INJECTION}` }],
          }),
        ),
      ).toBe('config');
      expect(
        await codeOf(() => buildMessage({ ...MESSAGE, messageId: `<a@example.invalid>${INJECTION}` })),
      ).toBe('config');
    });
  });

  await describe('message validation — recipients', async () => {
    await it('needs at least one plain address', async () => {
      expect(await codeOf(() => buildMessage({ ...MESSAGE, to: [] }))).toBe('config');
      expect(await codeOf(() => buildMessage({ ...MESSAGE, to: [''] }))).toBe('config');
      expect(await codeOf(() => buildMessage({ ...MESSAGE, to: ['no-at-sign'] }))).toBe('config');
      expect(await codeOf(() => buildMessage({ ...MESSAGE, to: ['A <a@example.invalid>'] }))).toBe('config');
      expect(
        await codeOf(() => buildMessage({ ...MESSAGE, to: ['a@example.invalid,b@example.invalid'] })),
      ).toBe('config');
    });

    await it('accepts what it should', async () => {
      expect(() =>
        validateMessage({ ...MESSAGE, to: ['a.b+tag@mail.example.invalid', 'x@localhost'] }),
      ).not.toThrow();
    });
  });

  await describe('account validation', async () => {
    await it('accepts a loopback account without TLS', async () => {
      expect(() => validateAccount(ACCOUNT)).not.toThrow();
      expect(() => validateAccount({ ...ACCOUNT, host: 'localhost' })).not.toThrow();
    });

    await it("allows security 'none' for loopback only", async () => {
      for (const host of [
        'mail.example.invalid',
        '192.0.2.1',
        '127.0.0.2',
        '::1',
        'localhost.example.invalid',
      ]) {
        expect(await codeOf(() => validateAccount({ ...ACCOUNT, host }))).toBe('config');
      }
      expect(() =>
        validateAccount({ ...ACCOUNT, host: 'mail.example.invalid', security: 'tls', port: 465 }),
      ).not.toThrow();
      expect(() =>
        validateAccount({ ...ACCOUNT, host: 'mail.example.invalid', security: 'starttls', port: 587 }),
      ).not.toThrow();
    });

    await it('rejects missing or malformed fields', async () => {
      const broken: unknown[] = [
        { ...ACCOUNT, host: '' },
        { ...ACCOUNT, host: 'a b' },
        { ...ACCOUNT, port: 0 },
        { ...ACCOUNT, port: 70000 },
        { ...ACCOUNT, port: 25.5 },
        { ...ACCOUNT, security: 'ssl' },
        { ...ACCOUNT, security: undefined },
        { ...ACCOUNT, username: undefined },
        { ...ACCOUNT, username: '' },
        { ...ACCOUNT, auth: undefined },
        { ...ACCOUNT, auth: { kind: 'password', password: '' } },
        { ...ACCOUNT, auth: { kind: 'oauth2' } },
        { ...ACCOUNT, auth: { kind: 'plain', password: 'x' } },
        { ...ACCOUNT, tls: { ca: '' } },
        { ...ACCOUNT, tls: { rejectUnauthorized: 'no' } },
        undefined,
      ];
      for (const account of broken) {
        expect(await codeOf(() => validateAccount(account as SmtpAccount))).toBe('config');
      }
    });

    await it('takes an oauth2 token and a tls block', async () => {
      expect(() =>
        validateAccount({
          ...ACCOUNT,
          host: 'mail.example.invalid',
          security: 'starttls',
          port: 587,
          auth: { kind: 'oauth2', accessToken: 'dummy-token' },
          tls: { ca: '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----', rejectUnauthorized: true },
        }),
      ).not.toThrow();
    });
  });
};
