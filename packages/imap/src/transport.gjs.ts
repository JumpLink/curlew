/**
 * IMAP transport on Gio: the TLS socket behind the `ByteStream` port (GJS-only).
 *
 * The one place in this package that touches Gio streams. Everything above it — the reader, the
 * client, the backend's command sequencing — sees `ByteStream` only (ADR 0018), so a platform
 * whose Gio has no TLS backend supplies another opener and nothing else changes.
 */

import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';

import { type ByteStream, GnomeError, type MailTarget } from '@curlew/protocol';

// Promisify the Gio async I/O we use (callback-only in @girs).
Gio._promisify(Gio.SocketClient.prototype, 'connect_to_host_async', 'connect_to_host_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async', 'write_all_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');

class GioByteStream implements ByteStream {
  private readonly conn: Gio.IOStream;
  private readonly input: Gio.InputStream;
  private readonly output: Gio.OutputStream;

  constructor(conn: Gio.IOStream) {
    this.conn = conn;
    this.input = conn.get_input_stream();
    this.output = conn.get_output_stream();
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
  return new GioByteStream(await socketClient.connect_to_host_async(target.host, target.port, null));
}
