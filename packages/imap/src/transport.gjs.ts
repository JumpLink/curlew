/**
 * IMAP transport on Gio: the TLS socket behind the `ByteStream` port (GJS-only).
 *
 * The one place in this package that touches Gio streams. Everything above it — the reader, the
 * client, the backend's command sequencing — sees `ByteStream` only (ADR 0018), so a platform
 * whose Gio has no TLS backend supplies another opener and nothing else changes.
 */

import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';

import {
  type ByteStream,
  GnomeError,
  type MailEndpoint,
  type MailTarget,
  type UpgradableByteStream,
} from '@curlew/protocol';

// Promisify the Gio async I/O we use (callback-only in @girs).
Gio._promisify(Gio.SocketClient.prototype, 'connect_to_host_async', 'connect_to_host_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async', 'write_all_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.TlsConnection.prototype, 'handshake_async', 'handshake_finish');

class GioByteStream implements UpgradableByteStream {
  private conn: Gio.IOStream;
  private input: Gio.InputStream;
  private output: Gio.OutputStream;
  private encrypted: boolean;
  private readonly host: string;
  private readonly port: number;

  constructor(conn: Gio.IOStream, encrypted: boolean, host = '', port = 0) {
    this.conn = conn;
    this.input = conn.get_input_stream();
    this.output = conn.get_output_stream();
    this.encrypted = encrypted;
    this.host = host;
    this.port = port;
  }

  /** STARTTLS: wrap the open connection in a client TLS connection and handshake, in place. */
  async upgradeTls(): Promise<void> {
    if (this.encrypted) throw new GnomeError('stream is already encrypted');
    const secure = Gio.TlsClientConnection.new(this.conn, Gio.NetworkAddress.new(this.host, this.port));
    await secure.handshake_async(GLib.PRIORITY_DEFAULT, null);
    this.conn = secure;
    this.input = secure.get_input_stream();
    this.output = secure.get_output_stream();
    this.encrypted = true;
  }

  async read(max: number): Promise<Uint8Array> {
    const bytes = await this.input.read_bytes_async(max, GLib.PRIORITY_DEFAULT, null);
    return bytes.toArray();
  }

  async write(bytes: Uint8Array): Promise<void> {
    await this.output.write_all_async(bytes, GLib.PRIORITY_DEFAULT, null);
  }

  async close(): Promise<void> {
    try {
      this.conn.close(null);
    } catch {
      // ignore — the peer may be gone already, and a second close reports "already closed"
    }
  }
}

/** Open a TLS connection to the target's IMAP port. */
export async function openTlsStream(target: MailTarget): Promise<ByteStream> {
  if (!target.implicitTls) {
    throw new GnomeError(
      `account ${target.accountId} uses STARTTLS (port ${target.port}); only implicit TLS (993) is supported currently`,
    );
  }
  const socketClient = new Gio.SocketClient();
  socketClient.set_tls(true);
  return new GioByteStream(await socketClient.connect_to_host_async(target.host, target.port, null), true);
}

/** Open a connection to an endpoint: TLS from the first byte, or plain and upgradable (SMTP). */
export async function openEndpointStream(endpoint: MailEndpoint): Promise<UpgradableByteStream> {
  if (endpoint.ca) throw new GnomeError('a custom CA is not supported by the Gio transport');
  const socketClient = new Gio.SocketClient();
  socketClient.set_tls(endpoint.tls === 'implicit');
  const conn = await socketClient.connect_to_host_async(endpoint.host, endpoint.port, null);
  return new GioByteStream(conn, endpoint.tls === 'implicit', endpoint.host, endpoint.port);
}
