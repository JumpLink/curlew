/**
 * IMAP/SMTP transport on `node:net` + `node:tls`: the socket behind the `ByteStream` port (Node).
 *
 * Certificate checks use Node's defaults (the bundled CA set, hostname verified against the
 * target's host); there is no switch to turn them off. Same contract as `transport.gjs.ts`.
 */

import net from 'node:net';
import tls from 'node:tls';

import {
  type ByteStream,
  GnomeError,
  type MailEndpoint,
  type MailTarget,
  type UpgradableByteStream,
} from '@curlew/protocol';

class SocketByteStream implements UpgradableByteStream {
  private socket: net.Socket;
  private encrypted: boolean;
  private readonly host: string;
  private readonly ca: string | undefined;
  private readonly chunks: Uint8Array[] = [];
  private ended = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;

  private readonly onData = (chunk: Uint8Array): void => {
    this.chunks.push(chunk);
    // Pull model: take one chunk, then stop the flow until the client asks for more, so a slow
    // reader is not buffered without bound.
    this.socket.pause();
    this.notify();
  };
  private readonly onEnd = (): void => this.finish();
  private readonly onError = (err: Error): void => {
    this.failure = err;
    this.finish();
  };

  constructor(socket: net.Socket, encrypted: boolean, host = '', ca?: string) {
    this.socket = socket;
    this.encrypted = encrypted;
    this.host = host;
    this.ca = ca;
    this.attach(socket);
  }

  private attach(socket: net.Socket): void {
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('close', this.onEnd);
    socket.on('error', this.onError);
  }

  private detach(socket: net.Socket): void {
    socket.off('data', this.onData);
    socket.off('end', this.onEnd);
    socket.off('close', this.onEnd);
    socket.off('error', this.onError);
    socket.on('error', () => {}); // the TLS layer reports it; an unhandled one would crash
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

  async upgradeTls(): Promise<void> {
    if (this.encrypted) throw new GnomeError('stream is already encrypted');
    if (this.chunks.length > 0 || this.ended || this.failure) {
      throw new GnomeError('cannot upgrade to TLS: unread or closed plaintext stream');
    }
    const raw = this.socket;
    this.detach(raw);
    // An IP literal is no valid SNI name; the certificate is still checked against it.
    const options: tls.ConnectionOptions = { socket: raw, ...(net.isIP(this.host) ? {} : { servername: this.host }) };
    if (this.ca) options.ca = this.ca;
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect(options, () => resolve(s));
      s.once('error', reject);
    });
    this.socket = secure;
    this.encrypted = true;
    this.attach(secure);
  }

  async close(): Promise<void> {
    this.socket.destroy();
  }
}

/** Test seam: extra trust anchors (PEM). Production callers pass nothing and get Node's defaults. */
export interface TlsStreamOptions {
  ca?: string;
}

/** Open a TLS connection to the target's IMAP port. */
export async function openTlsStream(target: MailTarget, options: TlsStreamOptions = {}): Promise<ByteStream> {
  if (!target.implicitTls) {
    throw new GnomeError(
      `account ${target.accountId} uses STARTTLS (port ${target.port}); only implicit TLS (993) is supported currently`,
    );
  }
  const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const s = tls.connect(
      { host: target.host, port: target.port, servername: target.host, ...(options.ca ? { ca: options.ca } : {}) },
      () => resolve(s),
    );
    s.once('error', reject);
  });
  return new SocketByteStream(socket, true);
}

/** Open a connection to an endpoint: TLS from the first byte, or plain and upgradable (SMTP). */
export async function openEndpointStream(endpoint: MailEndpoint): Promise<UpgradableByteStream> {
  const { host, port, ca } = endpoint;
  if (endpoint.tls === 'implicit') {
    const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const options: tls.ConnectionOptions = { host, port, ...(net.isIP(host) ? {} : { servername: host }) };
      if (ca) options.ca = ca;
      const s = tls.connect(options, () => resolve(s));
      s.once('error', reject);
    });
    return new SocketByteStream(socket, true, host, ca);
  }
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect({ host, port }, () => resolve(s));
    s.once('error', reject);
  });
  return new SocketByteStream(socket, false, host, ca);
}
