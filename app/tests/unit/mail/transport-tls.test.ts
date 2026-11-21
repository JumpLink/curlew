import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from '@gjsify/unit';

import { openTlsStream } from '../../../../packages/imap/src/transport.node.ts';
import type { ByteStream, MailTarget } from '@curlew/protocol';

import { isGjs } from '../../../src/core/runtime.ts';

// Hermetic loopback TLS: a local node:tls server with throwaway test-only certs
// (app/tests/fixtures/tls, found from the app dir, where the test script runs). Node-only: the server half needs node:tls listening sockets.
const fixture = (name: string) => readFileSync(join(process.cwd(), 'tests/fixtures/tls', name), 'utf8');

const CA = fixture('ca.pem');

interface Server {
  port: number;
  close(): Promise<void>;
}

/** Greets with `* OK test`, echoes every line back prefixed `echo:`, ends on `QUIT`. */
async function serve(host: string, cert = 'server'): Promise<Server> {
  const server = tls.createServer({ cert: fixture(`${cert}.pem`), key: fixture(`${cert}.key`) }, (socket) => {
    socket.on('error', () => {});
    socket.write('* OK test\r\n');
    socket.on('data', (data) => {
      const text = data.toString('latin1');
      if (text.startsWith('QUIT')) socket.end('* BYE\r\n');
      else socket.write(`echo:${text}`);
    });
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const targetFor = (host: string, port: number): MailTarget => ({
  accountId: 'acc',
  host,
  port,
  user: 'owner@example.org',
  implicitTls: true,
  getPassword: () => 'synthetic',
});

async function readText(stream: ByteStream, wanted: number): Promise<string> {
  let out = '';
  while (out.length < wanted) {
    const chunk = await stream.read(4096);
    if (chunk.length === 0) break;
    out += new TextDecoder().decode(chunk);
  }
  return out;
}

async function failure(run: () => Promise<unknown>): Promise<Error | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return err as Error;
  }
}

export default async () => {
  if (isGjs()) return;

  await describe('openTlsStream over loopback TLS (node)', async () => {
    await it('reads the greeting and round-trips a write with the CA trusted', async () => {
      const server = await serve('127.0.0.1');
      const stream = await openTlsStream(targetFor('localhost', server.port), { ca: CA });
      try {
        expect(await readText(stream, '* OK test\r\n'.length)).toBe('* OK test\r\n');
        await stream.write(new TextEncoder().encode('a1 NOOP\r\n'));
        const reply = 'echo:a1 NOOP\r\n';
        expect(await readText(stream, reply.length)).toBe(reply);
      } finally {
        await stream.close();
        await server.close();
      }
    });

    await it('rejects a self-signed certificate that is not trusted', async () => {
      const server = await serve('127.0.0.1', 'other');
      const err = await failure(() => openTlsStream(targetFor('localhost', server.port), { ca: CA }));
      await server.close();
      expect(err === null).toBe(false);
      expect(/self.signed|unable to verify|certificate/i.test(String(err?.message))).toBe(true);
    });

    await it('rejects the system trust store for the test CA (no seam, no trust)', async () => {
      const server = await serve('127.0.0.1');
      const err = await failure(() => openTlsStream(targetFor('localhost', server.port)));
      await server.close();
      expect(err === null).toBe(false);
      expect(/certificate|unable to verify/i.test(String(err?.message))).toBe(true);
    });

    await it('rejects a trusted certificate issued for another host name', async () => {
      // The leaf's SAN lists localhost and 127.0.0.1 only; 127.0.0.2 is loopback too.
      const server = await serve('127.0.0.2');
      const err = await failure(() => openTlsStream(targetFor('127.0.0.2', server.port), { ca: CA }));
      await server.close();
      expect(err === null).toBe(false);
      expect(/altnames|hostname|IP/i.test(String(err?.message))).toBe(true);
    });

    await it('reports EOF as an empty read after the server closes', async () => {
      const server = await serve('127.0.0.1');
      const stream = await openTlsStream(targetFor('localhost', server.port), { ca: CA });
      try {
        await readText(stream, '* OK test\r\n'.length);
        await stream.write(new TextEncoder().encode('QUIT\r\n'));
        expect(await readText(stream, '* BYE\r\n'.length)).toBe('* BYE\r\n');
        expect((await stream.read(4096)).length).toBe(0);
      } finally {
        await stream.close();
        await server.close();
      }
    });
  });
};
