/**
 * The port a mail connection reads and writes through (ADR 0018).
 *
 * Declared here, in the pure package, so the IMAP client is command sequencing over three
 * methods and knows nothing about the socket under it: Gio on the desktop and on Android, a
 * native TLS socket where Gio has none, a scripted double in a test. TLS is the implementation's
 * business — a stream handed out by a `MailStreamOpener` is already encrypted and verified.
 */

import { bytesToLatin1 } from './encoding.ts';
import type { MailTarget } from './types.ts';

export interface ByteStream {
  /**
   * The next bytes, at most `max` of them. Resolves as soon as ANY are available, so a short
   * read is normal; an empty array is the end of the stream, and stays the answer afterwards.
   */
  read(max: number): Promise<Uint8Array>;
  /** Resolves when every byte was handed to the transport, in call order. */
  write(bytes: Uint8Array): Promise<void>;
  /** Release the connection. Safe to call twice; never rejects for an already-dead peer. */
  close(): Promise<void>;
}

/** Opens the encrypted connection to a target's IMAP server, or rejects naming why not. */
export type MailStreamOpener = (target: MailTarget) => Promise<ByteStream>;

/**
 * Where a non-IMAP mail connection goes (SMTP, ADR 0018 amendment). `tls: 'implicit'` is TLS
 * from the first byte; `'none'` is a plain socket the caller upgrades with STARTTLS, or keeps
 * plain on loopback. `ca` is an extra trust anchor (PEM) for stacks that can take one; a stack
 * that cannot rejects the open instead of ignoring it.
 */
export interface MailEndpoint {
  host: string;
  port: number;
  tls: 'implicit' | 'none';
  ca?: string;
}

/** A stream that can switch to TLS in place: the STARTTLS half of the port. */
export interface UpgradableByteStream extends ByteStream {
  /**
   * Run the TLS handshake on the open connection, verified against the host it was opened for.
   * Afterwards `read` and `write` carry the encrypted session. The caller has consumed
   * everything the peer sent before (the reply to STARTTLS): unread plaintext rejects the
   * upgrade. Rejects if the stream is already encrypted or the handshake fails (certificate
   * included); the stream is unusable then and must be closed.
   */
  upgradeTls(): Promise<void>;
}

/** Opens a connection to an endpoint, encrypted from the start or upgradable later. */
export type MailEndpointOpener = (endpoint: MailEndpoint) => Promise<UpgradableByteStream>;

export const READ_CHUNK = 8192;

/** Incremental latin1 line/byte reader over a byte stream. */
export class ByteReader {
  // NOT a TypeScript parameter property: Node's --experimental-strip-types rejects those, which
  // would break the Node half of the test run. Same constraint as the error classes.
  private readonly stream: Pick<ByteStream, 'read'>;
  private buf = new Uint8Array(0);

  constructor(stream: Pick<ByteStream, 'read'>) {
    this.stream = stream;
  }

  /** Bytes read from the stream but not consumed yet. Must be 0 before a STARTTLS upgrade. */
  get buffered(): number {
    return this.buf.length;
  }

  private async fill(): Promise<boolean> {
    const arr = await this.stream.read(READ_CHUNK);
    if (arr.length === 0) return false; // EOF
    const merged = new Uint8Array(this.buf.length + arr.length);
    merged.set(this.buf);
    merged.set(arr, this.buf.length);
    this.buf = merged;
    return true;
  }

  /** Read one CRLF-terminated line as latin1 (without the terminator); null at EOF. */
  async readLine(): Promise<string | null> {
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl >= 0) {
        let end = nl;
        if (end > 0 && this.buf[end - 1] === 0x0d) end--; // strip CR
        const line = bytesToLatin1(this.buf.subarray(0, end));
        this.buf = this.buf.slice(nl + 1);
        return line;
      }
      if (!(await this.fill())) {
        if (this.buf.length === 0) return null;
        const line = bytesToLatin1(this.buf);
        this.buf = new Uint8Array(0);
        return line;
      }
    }
  }

  /** Read exactly n raw bytes (fewer only at EOF). */
  async readBytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) {
      if (!(await this.fill())) break;
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(out.length);
    return out;
  }

  /**
   * Stream exactly n bytes into a sink, never holding more than one chunk.
   *
   * The difference from readBytes() is the whole reason attachments are usable: readBytes turns
   * the literal into a latin1 JS string, so a 20 MB PDF costs 20 MB of bytes PLUS ~40 MB of
   * UTF-16 string. Here peak memory is O(chunk) regardless of attachment size.
   *
   * Returns the number of bytes actually delivered — short only at EOF, which is a truncated
   * transfer the caller must treat as a failure.
   */
  async pipeBytes(n: number, write: (chunk: Uint8Array) => void | Promise<void>): Promise<number> {
    let remaining = n;
    while (remaining > 0) {
      if (this.buf.length === 0 && !(await this.fill())) break; // EOF
      const take = Math.min(remaining, this.buf.length);
      await write(this.buf.subarray(0, take));
      this.buf = this.buf.slice(take);
      remaining -= take;
    }
    return n - remaining;
  }

  /** Discard exactly n bytes without materializing them (used to resync after a refusal). */
  async skipBytes(n: number): Promise<number> {
    return this.pipeBytes(n, () => {});
  }
}
