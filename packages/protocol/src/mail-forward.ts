/**
 * The forwarded-message format of Delta Chat over mail (spec 0.37): the body opens with the exact
 * line `---------- Forwarded message ----------`, then `From: <address>`, a blank line, the text.
 * Pure: no `gi://`, no `node:*`.
 */

/** Ten minus signs, a space, the words, a space, ten minus signs: nothing else counts. */
export const FORWARD_HEADER = '---------- Forwarded message ----------';

export interface ForwardedText {
  /** The address the second line names, or null when there is none. */
  from: string | null;
  /** The forwarded text without the two header lines. */
  text: string;
}

/** The body to send when forwarding `text` that `from` wrote. */
export function forwardedBody(from: string, text: string): string {
  return `${FORWARD_HEADER}\nFrom: ${from.trim()}\n\n${text}`;
}

/**
 * Whether `body` is a forwarded message: only a body whose FIRST line is exactly the header is.
 * A text that merely mentions or resembles it further down, or with other dashes, is not.
 */
export function parseForwarded(body: string | null | undefined): ForwardedText | null {
  if (!body) return null;
  const lines = body.split(/\r?\n/);
  if (lines[0] !== FORWARD_HEADER) return null;
  let rest = lines.slice(1);
  let from: string | null = null;
  const second = /^From: (.+)$/.exec(rest[0] ?? '');
  if (second) {
    from = second[1].trim();
    rest = rest.slice(1);
  }
  if (rest[0] === '') rest = rest.slice(1);
  return { from, text: rest.join('\n') };
}
