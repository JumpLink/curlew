import { describe, expect, it } from '@gjsify/unit';

import { openEndpointStream } from '../../../../packages/imap/src/transport.node.ts';
import { sendOverWire, verifyOverWire } from '@curlew/smtp/wire';
import type { SmtpError } from '@curlew/smtp/wire';
import type { SmtpAccount } from '@curlew/smtp/wire';

import { isGjs } from '../../../src/core/runtime.ts';
import { startDummyServer } from './dummy-server.ts';
import { tlsCredentials } from './tls-fixture.ts';

// Node only: the server half needs node:net/node:tls listening sockets. Loopback with a
// throwaway self-signed cert generated per run (tls-fixture.ts), never committed.
const PASSWORD = 'SECRET-pa55w0rd-for-tests';
const ENVELOPE = { from: 'sender@example.invalid', to: ['a@example.invalid', 'gone@example.invalid'] };
const RAW = new TextEncoder().encode('Subject: hi\n\n.dot line\nbody\n');

const accountFor = (port: number, security: SmtpAccount['security'], ca?: string): SmtpAccount => ({
  host: '127.0.0.1',
  port,
  security,
  username: 'user@example.invalid',
  auth: { kind: 'password', password: PASSWORD },
  ...(ca === undefined ? {} : { tls: { ca } }),
});

async function failure(run: () => Promise<unknown>): Promise<SmtpError> {
  try {
    await run();
  } catch (err) {
    return err as SmtpError;
  }
  throw new Error('expected an error');
}

export default async () => {
  if (isGjs()) return;

  await describe('SMTP wire client over loopback sockets (node)', async () => {
    await it('sends over implicit TLS with the CA trusted', async () => {
      const server = await startDummyServer({ tls: 'implicit', rejectRecipients: ['gone@example.invalid'] });
      try {
        const result = await sendOverWire(accountFor(server.port, 'tls', tlsCredentials().cert), ENVELOPE, RAW, openEndpointStream);
        expect(result.accepted).toStrictEqual(['a@example.invalid']);
        expect(result.rejected).toStrictEqual(['gone@example.invalid']);
        expect(server.dialogue.messages).toStrictEqual(['Subject: hi\r\n\r\n..dot line\r\nbody\r\n']);
        expect(server.dialogue.commands.some((c) => c.startsWith('AUTH PLAIN '))).toBe(true);
      } finally {
        await server.close();
      }
    });

    await it('upgrades with STARTTLS, says EHLO again, then sends', async () => {
      const server = await startDummyServer({ tls: 'starttls' });
      try {
        await sendOverWire(accountFor(server.port, 'starttls', tlsCredentials().cert), ENVELOPE, RAW, openEndpointStream);
        const verbs = server.dialogue.commands.map((c) => c.split(' ')[0]);
        expect(verbs.slice(0, 4)).toStrictEqual(['EHLO', 'STARTTLS', 'EHLO', 'AUTH']);
        expect(server.dialogue.messages.length).toBe(1);
      } finally {
        await server.close();
      }
    });

    await it('refuses a certificate the CA does not cover, as a tls error', async () => {
      const server = await startDummyServer({ tls: 'implicit' });
      try {
        const err = await failure(() =>
          verifyOverWire(accountFor(server.port, 'tls', tlsCredentials().otherCert), openEndpointStream),
        );
        expect(err.code).toBe('tls');
      } finally {
        await server.close();
      }
    });

    await it('refuses the STARTTLS upgrade against an untrusted certificate, and sends no AUTH', async () => {
      const server = await startDummyServer({ tls: 'starttls' });
      try {
        const err = await failure(() =>
          verifyOverWire(accountFor(server.port, 'starttls', tlsCredentials().otherCert), openEndpointStream),
        );
        expect(err.code).toBe('tls');
        expect(server.dialogue.commands.some((c) => c.startsWith('AUTH'))).toBe(false);
      } finally {
        await server.close();
      }
    });

    await it('a server that refuses STARTTLS (454) is a tls error', async () => {
      const server = await startDummyServer({ tls: 'starttls', refuseStarttls: true });
      try {
        const err = await failure(() =>
          verifyOverWire(accountFor(server.port, 'starttls', tlsCredentials().cert), openEndpointStream),
        );
        expect(err.code).toBe('tls');
        expect(err.responseCode).toBe(454);
      } finally {
        await server.close();
      }
    });

    await it('works in plain on loopback with security none', async () => {
      const server = await startDummyServer();
      try {
        await verifyOverWire(accountFor(server.port, 'none'), openEndpointStream);
        expect(server.dialogue.commands[0].startsWith('EHLO')).toBe(true);
      } finally {
        await server.close();
      }
    });

    await it('a closed port is a connect error', async () => {
      const server = await startDummyServer();
      const port = server.port;
      await server.close();
      const err = await failure(() => verifyOverWire(accountFor(port, 'none'), openEndpointStream));
      expect(err.code).toBe('connect');
    });
  });
};
