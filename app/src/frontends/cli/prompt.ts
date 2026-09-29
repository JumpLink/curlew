/**
 * The terminal's side of `AccountPrompter`: questions on stderr, answers from stdin.
 *
 * ONE readline interface for the whole login, with its own line queue: a second interface on the
 * same stdin would lose whatever the first had already buffered, which is exactly what happens
 * when the answers are piped in. Secret answers are read with echo off when stdin is a terminal
 * (readline's echo goes through a muted stream); piped input is not echoed anyway.
 */

import type { AccountPrompter } from '@postbote/protocol';

import type { SetupPrompter } from '../../core/actions/setup.ts';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export function terminalPrompter(): AccountPrompter & { close(): void } {
  return readPrompter() as AccountPrompter & { close(): void };
}

/**
 * The same terminal prompter, with the one method a backend login never needs and a wizard
 * cannot do without: a yes/no question. It is the SAME implementation and the same readline
 * interface, not a second one — two interfaces on one stdin lose each other's buffered lines,
 * and this object has to be shared: `postbote setup` asks its own questions AND hands this very
 * object to the linking actions, so a QR code and a yes/no question cannot fight over stdin.
 *
 * An unanswered question is NO. The readline interface closing mid-run (EOF, a closed pipe) must
 * never read as consent — that would accept somebody's terms for them.
 */
export function terminalSetupPrompter(): SetupPrompter & { close(): void } {
  return readPrompter();
}

function readPrompter(): SetupPrompter & { close(): void } {
  const tty = Boolean((process.stdin as { isTTY?: boolean }).isTTY);
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: tty });
  const lines: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on('line', (line: string) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const next of waiting.splice(0)) next(null);
  });

  /** The next line, from the buffer or from stdin; null once input has ended. */
  const next = (): Promise<string | null> => {
    const buffered = lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (closed) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => waiting.push(resolve));
  };

  return {
    async ask(label, options = {}) {
      process.stderr.write(`${label}: `);
      muted = Boolean(options.secret) && tty;
      const line = await next();
      if (muted) process.stderr.write('\n');
      muted = false;
      if (line === null) throw new Error('input ended before the login was complete — nothing was saved');
      return line.trim();
    },
    async confirm(question) {
      // `[y/N]`, on stderr like every other question here, so a piped stdout stays machine-readable.
      process.stderr.write(`${question} [y/N] `);
      const line = await next();
      // Only an explicit y/Y counts. No line at all (EOF) is a NO, never a consent.
      return line !== null && /^[Yy]$/.test(line.trim());
    },
    notify(message) {
      process.stderr.write(`${message}\n`);
    },
    close() {
      rl.close();
    },
  };
}
