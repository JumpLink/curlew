import { describe, expect, it } from '@gjsify/unit';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What curlew's XMPP backend asks of `node:tls`, against a REAL TLS server on the loopback.
 *
 * There was a reason none of this could be tested: on GJS no raw TLS socket worked. A plain
 * `tls.connect()` failed its handshake with `G_IO_ERROR_PENDING` (the socket's own read was still
 * in flight on the stream TLS wanted), and `tls.connect({ socket })` ignored the socket, so a
 * STARTTLS upgrade was impossible — the backend dropped both endpoint kinds and reached only
 * WebSocket. gjsify#1837 fixed the handshake, wired `options.socket`, and made `end()` send
 * `close_notify`, and all three are pinned here on BOTH runtimes.
 *
 * A whole XMPP login over direct TLS stayed broken on GJS after all of that, for a reason none of
 * these four cases could see: gjsify's `Readable` made `on()` enter flowing mode on a `'data'`
 * listener but left `addListener` as a different function, and `@xmpp/tls` subscribes `'data'`
 * through `addListener`. The handshake completed and the peer's bytes arrived, unread. gjsify#1958
 * made the two names the same function; the last case below now pins THAT — the byte flow these
 * primitives exist for, subscribed the way xmpp.js subscribes it — because it is the difference
 * between a handshake and a login.
 *
 * The certificate is generated per run with the system `openssl` and lives only in a temp dir.
 * It is self-signed for `localhost`, and it is what the `ca` option pins — which is also why the
 * last case below is there: a handshake that ignored `ca` would have nothing to verify against.
 *
 * Every case goes through `settle()`, because the failure these guard against is a HANG. A
 * thrown error would fail the test; a socket that waits forever would not, so each promise is
 * given a deadline and its outcome is asserted as a value.
 */

/** Long enough for a loopback handshake, short enough that a hang is a red test, not a stall. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** A self-signed cert/key pair for localhost, generated on the spot. Synthetic, never committed. */
function makeCert(dir: string): { key: string; ca: string } {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(key, 'utf8'), ca: readFileSync(cert, 'utf8') };
}

/**
 * A quiet TLS server on the loopback: the handshake is the subject, not the protocol.
 *
 * `reply`, when given, is written once per connection — the byte flow the last case needs, which
 * the handshake cases deliberately have nothing to do with.
 */
async function withTlsServer(
  run: (port: number, ca: string) => Promise<void>,
  reply?: string,
): Promise<void> {
  const tls = await import('node:tls');
  const dir = mkdtempSync(join(tmpdir(), 'curlew-tls-'));
  try {
    const { key, ca } = makeCert(dir);
    const server = tls.createServer({ key, cert: ca }, (socket) => {
      if (reply !== undefined) socket.write(reply);
      socket.on('data', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await run((server.address() as AddressInfo).port, ca);
    } finally {
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A promise's outcome as a value, under a deadline.
 *
 * `'|true'` is the success a case below asserts: an empty error and `ok`. A hang becomes
 * `'timeout|false'` rather than never returning. What the promise RESOLVED with is kept in
 * `value`, for the one case that asserts on the bytes rather than on the completion.
 */
function settle<T>(promise: Promise<T>): Promise<{ ok: boolean; error: string; value?: T }> {
  const deadline = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), HANDSHAKE_TIMEOUT_MS),
  );
  const outcome = promise.then(
    (value: T) => ({ ok: true, error: '', value }),
    (err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  return Promise.race([outcome, deadline]).then((r) => (typeof r === 'string' ? { ok: false, error: r } : r));
}

export default async () => {
  await describe('TLS sockets (what the XMPP transport needs)', async () => {
    await it('completes a raw handshake against a certificate given as `ca`', async () => {
      const tls = await import('node:tls');
      await withTlsServer(async (port, ca) => {
        const result = await settle(
          new Promise<void>((resolve, reject) => {
            const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca }, () => {
              if (!socket.authorized) {
                reject(new Error(`not authorized: ${String(socket.authorizationError)}`));
                return;
              }
              socket.destroy();
              resolve();
            });
            socket.on('error', reject);
          }),
        );
        // `ca` is load-bearing twice over: it is how the pinned root is trusted, and a handshake
        // that ignored it would have nothing to verify against.
        expect(`${result.error}|${result.ok}`).toBe('|true');
      });
    });

    await it('upgrades an already-open plaintext socket in place, as STARTTLS does', async () => {
      const tls = await import('node:tls');
      const net = await import('node:net');
      await withTlsServer(async (port, ca) => {
        // The shape xmpp.js's `starttls` plugin uses, and the one that used to be impossible: a
        // net.Socket that is already connected, handed to `tls.connect({ socket })`. Bytes written
        // after the upgrade must travel over TLS, and the plaintext socket must not deliver them
        // a second time — a surviving second reader is how a message is lost without an error.
        const result = await settle(
          new Promise<void>((resolve, reject) => {
            const plain = net.connect(port, '127.0.0.1', () => {
              const upgraded = tls.connect({ socket: plain, servername: 'localhost', ca }, () => {
                if (!upgraded.authorized) {
                  reject(new Error(`not authorized: ${String(upgraded.authorizationError)}`));
                  return;
                }
                upgraded.write('over the upgraded socket');
                upgraded.on('close', () => resolve());
                upgraded.end();
              });
              upgraded.on('error', reject);
            });
            plain.on('error', reject);
          }),
        );
        expect(`${result.error}|${result.ok}`).toBe('|true');
      });
    });

    await it('closes on end() rather than waiting for a peer that never answers', async () => {
      const tls = await import('node:tls');
      await withTlsServer(async (port, ca) => {
        // `end()` used to reach no one: @gjsify/net half-closes through a Gio call a TLS
        // connection does not have, so the exception was swallowed, no `close_notify` went out,
        // and with `allowHalfOpen` on both sides each waited for the other forever — which is
        // why xmpp.js's `stop()` hung on a direct-TLS connection. This server answers nothing,
        // so the deadline above is what a regression trips.
        const result = await settle(
          new Promise<void>((resolve, reject) => {
            const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca }, () => {
              socket.on('close', () => resolve());
              socket.end();
            });
            socket.on('error', reject);
          }),
        );
        expect(`${result.error}|${result.ok}`).toBe('|true');
      });
    });

    await it('refuses a certificate the `ca` does not cover', async () => {
      const tls = await import('node:tls');
      await withTlsServer(async (port) => {
        // The other half of the first case: `ca` is not decoration. With no root to verify
        // against, a self-signed certificate must be refused — the defect gjsify#1843 fixed for
        // `node:https`, where `ca` was dropped and Signal's pinned root was refused with
        // "Inakzeptables TLS-Zertifikat".
        const result = await settle(
          new Promise<void>((resolve, reject) => {
            const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost' }, () => {
              if (socket.authorized) {
                socket.destroy();
                reject(new Error('an untrusted self-signed certificate was accepted'));
                return;
              }
              socket.destroy();
              resolve();
            });
            socket.on('error', (err: Error & { code?: string }) => {
              socket.destroy();
              // A refusal arrives as 'error' rather than as a flag, and carries Node's own code
              // for it — measured on GJS as DEPTH_ZERO_SELF_SIGNED_CERT with the message
              // "self-signed certificate". Anything else is a real failure.
              if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || /self-signed/i.test(err.message)) {
                resolve();
                return;
              }
              reject(err);
            });
          }),
        );
        expect(`${result.error}|${result.ok}`).toBe('|true');
      });
    });

    await it("delivers the peer's bytes to an addListener subscriber, the way xmpp.js asks", async () => {
      const tls = await import('node:tls');
      const payload = `<?xml version='1.0'?><stream:stream from='localhost'>`;
      await withTlsServer(async (port, ca) => {
        // The whole XMPP stall, without an XMPP server. @xmpp/events' `onoff()` resolves
        // `addEventListener ?? addListener`, so @xmpp/tls subscribes 'data' through
        // `addListener` — and gjsify's Readable used to treat that as an ordinary event while
        // `on()` alone switched the stream to flowing mode. The server's answer then sat unread in
        // the readable buffer and `entity.status` stayed 'opening' until the login timed out.
        // gjsify#1958 made the two names the same function; that is what the alias assertion pins,
        // and the bytes are what the composition actually needed.
        const result = await settle(
          new Promise<{ alias: boolean; bytes: number; flowing: unknown }>((resolve, reject) => {
            const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca }, () => {
              let bytes = 0;
              socket.addListener('data', (chunk: string | Uint8Array) => {
                bytes += typeof chunk === 'string' ? chunk.length : chunk.byteLength;
                resolve({
                  alias: (socket.addListener as unknown) === (socket.on as unknown),
                  bytes,
                  flowing: (socket as unknown as { readableFlowing?: unknown }).readableFlowing,
                });
                socket.destroy();
              });
            });
            socket.on('error', reject);
          }),
        );
        expect(`${result.error}|${result.ok}`).toBe('|true');
        const out = result.value ?? { alias: false, bytes: -1, flowing: 'unset' };
        expect(`${out.alias}|${out.bytes}|${out.flowing}`).toBe(`true|${payload.length}|true`);
      }, payload);
    });
  });
};
