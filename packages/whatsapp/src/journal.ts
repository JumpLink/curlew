/**
 * The write-ahead journal of the receive path.
 *
 * Baileys acknowledges a message to WhatsApp BEFORE it emits it (Socket/messages-recv.ts: the
 * `sendReceipt` in `handleMessage` runs before `upsertMessage`), and WhatsApp deletes what was
 * acknowledged. Between that event and the index transaction that stores it, the message
 * exists only in this process — a crash, a SIGKILL, an OOM there would lose it for good. So the
 * event handler appends every mapped event here, synchronously and fsync'ed, before it returns
 * to Baileys; the store engine's next `nextBatch()` call (its acknowledgement that the previous
 * batch is committed) drops that batch from the journal; and a session that finds a journal
 * left by a crash replays it into the store before anything new.
 *
 * Format: one JSON-serialized `DeliveryEvent` per line. A torn last line (the crash hit the
 * write) is not just skipped but CUT: the bytes are removed before anything is appended, because
 * an append would otherwise splice the next event onto them and lose that one instead — and that
 * one was already acknowledged to WhatsApp, so it exists nowhere else. Its own write never
 * returned, hence was never acknowledged either: WhatsApp delivers it again. Replaying an event the
 * store already has is harmless: every write is keyed (a message row by chat and id), so recovery
 * yields each message exactly once.
 *
 * Where: `<account id>.journal` next to the account's session file, in the backend's secrets
 * directory (0700; the file 0600). It holds message content, so it needs at least the index's
 * protection, and the secrets tier gives more (encrypted in backups). It is also the only
 * directory a backend is handed (`BackendContext.secretsDir`) — the index location is the
 * store's business. The file is empty whenever no sync is running or the last one ended well.
 */

import type { DeliveryEvent } from '@curlew/protocol';
import { ensurePrivateDir } from '@curlew/store';
import { Buffer } from 'node:buffer';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** What the receiver needs from a journal — a test can hand in one that fails on purpose. */
export interface EventJournal {
  /** Events a crashed run left behind, to be written before anything new. */
  readonly recovered: readonly DeliveryEvent[];
  /** Append durably: returns only once the events are on disk. */
  append(events: readonly DeliveryEvent[]): void;
  /** Bytes written so far — the mark a handed-out batch ends at, an offset into the file itself. */
  size(): number;
  /** Drop everything before `mark`: that batch is committed to the index. */
  release(mark: number): void;
  close(): void;
}

export class FileJournal implements EventJournal {
  readonly path: string;
  readonly recovered: DeliveryEvent[];
  private fd: number;
  private bytes: number;
  /** Set by `close()`: a release or a second close after it is a no-op, not EBADF. */
  private closed = false;

  private constructor(path: string, recovered: DeliveryEvent[], bytes: number) {
    this.path = path;
    this.recovered = recovered;
    this.bytes = bytes;
    this.fd = FileJournal.openAppend(path, bytes);
  }

  private static openAppend(path: string, size: number): number {
    const fd = openSync(path, 'a', 0o600);
    // Again after open: a file restored from elsewhere may carry another mode.
    chmodSync(path, 0o600);
    // The file is cut to what this journal decided is on disk, so `size()` — which a handed-out
    // batch is released against — is an offset into exactly these bytes. After a crash that also
    // discards the torn tail, and an empty file stays an empty file.
    ftruncateSync(fd, size);
    fsyncSync(fd);
    return fd;
  }

  static open(path: string): FileJournal {
    ensurePrivateDir(dirname(path));
    if (!existsSync(path)) return new FileJournal(path, [], 0);
    const raw = readFileSync(path);
    // A crash can stop in the middle of a line's write. Those bytes are not merely unread — they
    // are a trap: `append` opens with 'a' and would splice the next event onto them, and then that
    // event is unreadable too. It was acknowledged to WhatsApp before this run started, so the
    // server will never deliver it again: the next append would lose a message for good. Cut the
    // file back to the end of the last complete line instead. The discarded event's write never
    // returned, hence was never acknowledged, so WhatsApp delivers it again.
    const end = raw.lastIndexOf(0x0a) + 1;
    const recovered: DeliveryEvent[] = [];
    for (const line of raw.toString('utf8', 0, end).split('\n')) {
      if (!line) continue;
      try {
        recovered.push(JSON.parse(line) as DeliveryEvent);
      } catch {
        // A line that ends in '\n' but never fully reached the disk. Skipped on every open; it
        // cannot swallow a following event, because that one is a line of its own.
      }
    }
    return new FileJournal(path, recovered, end);
  }

  append(events: readonly DeliveryEvent[]): void {
    if (events.length === 0) return;
    const chunk = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
    writeSync(this.fd, chunk);
    fsyncSync(this.fd);
    this.bytes += Buffer.byteLength(chunk);
  }

  size(): number {
    return this.bytes;
  }

  release(mark: number): void {
    // After a close, a release is a no-op. The engine closes the journal on a stop and may still
    // hold a handed-out mark, which the next `nextBatch()` releases — a truncate on a closed
    // descriptor is EBADF, and that would be reported as the error of an otherwise clean stop.
    if (this.closed) return;
    if (mark <= 0) return;
    if (mark >= this.bytes) {
      ftruncateSync(this.fd, 0);
      fsyncSync(this.fd);
      this.bytes = 0;
      return;
    }
    // Events arrived after the released batch: keep them, atomically (write, fsync, rename).
    const rest = readFileSync(this.path).subarray(mark);
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, rest);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    closeSync(this.fd);
    renameSync(tmp, this.path);
    this.fd = FileJournal.openAppend(this.path, rest.length);
    this.bytes = rest.length;
  }

  close(): void {
    // Twice is fine: a receiver closes on a stop and the caller closes again in its own unwind.
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}

/** Where an account's journal lives: next to its session file. */
export function journalPath(sessionFile: string): string {
  return sessionFile.replace(/\.db$/, '.journal');
}
