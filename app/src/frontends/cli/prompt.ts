/**
 * The terminal's side of `AccountPrompter`: questions on stderr, answers from stdin.
 *
 * ONE readline interface for the whole login, with its own line queue: a second interface on the
 * same stdin would lose whatever the first had already buffered, which is exactly what happens
 * when the answers are piped in. Secret answers are read with echo off when stdin is a terminal
 * (readline's echo goes through a muted stream); piped input is not echoed anyway.
 */

import type { AccountPrompter } from '@curlew/protocol';

import type { SetupPrompter } from '../../core/actions/setup.ts';
import { createInterface } from 'node:readline';
import { isatty } from 'node:tty';
import { bold, dim } from './colour.ts';
import { Writable } from 'node:stream';

export function terminalPrompter(): AccountPrompter & { close(): void } {
  return readPrompter() as AccountPrompter & { close(): void };
}

/**
 * The same terminal prompter, with the one method a backend login never needs and a wizard
 * cannot do without: a yes/no question. It is the SAME implementation and the same readline
 * interface, not a second one — two interfaces on one stdin lose each other's buffered lines,
 * and this object has to be shared: `curlew setup` asks its own questions AND hands this very
 * object to the linking actions, so a QR code and a yes/no question cannot fight over stdin.
 *
 * An unanswered question is NO. The readline interface closing mid-run (EOF, a closed pipe) must
 * never read as consent — that would accept somebody's terms for them.
 */
export function terminalSetupPrompter(): SetupPrompter & { close(): void } {
  return readPrompter();
}

/**
 * Is the stream on the far end a terminal? `isatty`, NOT `process.stdin.isTTY`.
 *
 * Under GJS that property is not implemented — gjsify's own spec says "should have
 * isTTY property **if available**" and only checks its type when it is not undefined —
 * so `Boolean(undefined)` is false on a GNOME Terminal, and readline never built itself
 * in terminal mode: no keypress handling, no raw mode, no line editing. gjsify's `isatty`
 * asks GLib (`log_writer_supports_color`, or the real POSIX call when
 * `@gjsify/terminal-native` is installed) and answers correctly under both runtimes.
 *
 * This is the precondition, not the whole repair. Measured on a real pty: with terminal mode
 * reached, @gjsify/readline still puts the tty in raw mode without writing the typed character
 * back, and Ctrl-C never becomes a SIGINT. That is a defect in the dependency and is being
 * fixed there; a consumer must not paper over it, because the next prompt would hit the wall
 * again and the workaround would ossify.
 *
 * Injectable, because a bug that only shows up on a real terminal is a bug whose test would
 * otherwise need a real terminal.
 */
export function stdinIsTTY(): boolean {
  return isatty(0);
}

export function readPrompter(
  isTTY: () => boolean = stdinIsTTY,
  input: NodeJS.ReadableStream = process.stdin,
): SetupPrompter & { close(): void } {
  // Every question here goes to stderr, so that is the descriptor the styling is gated on.
  const ERR = 2;
  const tty = isTTY();
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input, output, terminal: tty });
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
      process.stderr.write(`${bold(`${label}:`, ERR)} `);
      muted = Boolean(options.secret) && tty;
      const line = await next();
      if (muted) process.stderr.write('\n');
      muted = false;
      if (line === null) throw new Error('input ended before the login was complete — nothing was saved');
      return line.trim();
    },
    async confirm(question) {
      // `[y/N]`, on stderr like every other question here, so a piped stdout stays machine-readable.
      process.stderr.write(`${bold(question, ERR)} ${dim('[y/N]', ERR)} `);
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
