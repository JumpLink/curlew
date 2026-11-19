import type { ByteStream } from '@curlew/protocol';

/**
 * A `ByteStream` double: a fake server that answers each write. Synthetic only — no socket, so
 * the IMAP client runs against it on every runtime.
 */
export class ScriptedStream implements ByteStream {
  readonly written: string[] = [];
  closed = 0;
  private readonly pending: Uint8Array[] = [];
  private waiting: ((chunk: Uint8Array) => void) | null = null;
  private readonly answer: (written: string) => string | undefined;

  /** `greeting` is what the server says first; `answer` maps one client write to the reply. */
  constructor(greeting: string, answer: (written: string) => string | undefined) {
    this.answer = answer;
    this.push(greeting);
  }

  private push(text: string): void {
    const chunk = Uint8Array.from(text, (c) => c.charCodeAt(0));
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(chunk);
    } else {
      this.pending.push(chunk);
    }
  }

  async read(max: number): Promise<Uint8Array> {
    if (this.closed > 0) return new Uint8Array(0);
    const head = this.pending.shift();
    if (head === undefined) return new Promise((resolve) => (this.waiting = resolve));
    if (head.length <= max) return head;
    this.pending.unshift(head.subarray(max));
    return head.subarray(0, max);
  }

  async write(bytes: Uint8Array): Promise<void> {
    const text = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    this.written.push(text);
    const reply = this.answer(text);
    if (reply !== undefined) this.push(reply);
  }

  async close(): Promise<void> {
    this.closed++;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(new Uint8Array(0));
    }
  }
}
