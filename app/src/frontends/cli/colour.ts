/**
 * ANSI styling for the terminal surfaces, on only where it can be seen.
 *
 * A `NO_COLOR` in the environment switches it off, as it does everywhere. So does a pipe: the
 * gates below ask `isatty`, so `curlew setup --status > out.txt` writes plain text and a
 * person reading it in a pager gets no escape sequences. That is the whole reason this is a
 * function and not a constant — a `--status` is a thing a person may well pipe, and escape
 * codes in a file are worse than no colour at all.
 *
 * `isatty` and not `process.stdout.isTTY`, for the reason in `stdinIsTTY()`: that property is
 * not implemented under GJS, so it would answer "not a terminal" in a GNOME Terminal and the
 * colour would never appear. This is a second consumer of the same wrong answer, which is why
 * the predicate lives in one place and is exported.
 */
import { isatty } from 'node:tty';

/** Whether a given descriptor can show styling. `NO_COLOR` wins over a capable terminal. */
export function colourOn(fd: number): boolean {
  return process.env.NO_COLOR === undefined || process.env.NO_COLOR === '' ? isatty(fd) : false;
}

const wrap =
  (open: string, close: string) =>
  (text: string, fd: number): string =>
    colourOn(fd) ? `\u001b[${open}m${text}\u001b[${close}m` : text;

export const bold = wrap('1', '22');
export const dim = wrap('2', '22');
export const red = wrap('31', '39');
export const green = wrap('32', '39');
export const yellow = wrap('33', '39');
export const blue = wrap('34', '39');

/**
 * A stage's state, coloured by what it means rather than by the word: done is the only green
 * one, a warning is yellow, and `remaining` is dim because it is the ordinary case. A person
 * scanning a long list should find the two that need them without reading a word.
 */
export function stateWord(state: 'done' | 'remaining' | 'skipped', fd: number): string {
  if (state === 'done') return green(state, fd);
  if (state === 'skipped') return dim(state, fd);
  return yellow(state, fd);
}
