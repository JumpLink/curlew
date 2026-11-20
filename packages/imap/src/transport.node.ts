/**
 * IMAP transport on `node:tls`: the TLS socket behind the `ByteStream` port (Node).
 *
 * Certificate checks use Node's defaults (the bundled CA set, hostname verified against the
 * target's host); there is no switch to turn them off. Same contract as `transport.gjs.ts`.
 */

import tls from 'node:tls';

import { type ByteStream, GnomeError, type MailTarget } from '@curlew/protocol';

class TlsByteStream implements ByteStream {
  private readonly socket: tls.TLSSocket;
  private readonly chunks: Uint8Array[] = [];
  private ended = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;

  constructor(socket: tls.TLSSocket) {
    this.socket = socket;
    // Pull model: take one chunk, then stop the flow until the client asks for more, so a slow
    // reader is not buffered without bound.
    socket.on('data', (chunk: Uint8Array) => {
      this.chunks.push(chunk);
      socket.pause();
      this.notify();
    });
    socket.on('end', () => this.finish());
    socket.on('close', () => this.finish());
    socket.on('error', (err) => {
      this.failure = err;
      this.finish();
    });
  }

  private finish(): void {
    this.ended = true;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async read(max: number): Promise<Uint8Array> {
    for (;;) {
      const head = this.chunks[0];
      if (head) {
        if (head.length <= max) {
          this.chunks.shift();
          if (this.chunks.length === 0) this.socket.resume();
          return head;
        }
        this.chunks[0] = head.subarray(max);
        return head.subarray(0, max);
      }
      if (this.failure) throw this.failure;
      if (this.ended) return new Uint8Array(0);
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.write(bytes, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.socket.destroy();
  }
}

/** Open a TLS connection to the target's IMAP port. */
export async function openTlsStream(target: MailTarget): Promise<ByteStream> {
  if (!target.implicitTls) {
    throw new GnomeError(
      `account ${target.accountId} uses STARTTLS (port ${target.port}); only implicit TLS (993) is supported currently`,
    );
  }
  const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const s = tls.connect({ host: target.host, port: target.port, servername: target.host }, () => resolve(s));
    s.once('error', reject);
  });
  return new TlsByteStream(socket);
}
