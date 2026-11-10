/**
 * A message's text as Pango markup: links become clickable and a conservative subset of inline
 * Markdown (`**bold**`, `*italic*`, `_italic_`, `~~strike~~`, `` `code` ``) is styled, the way Fractal,
 * Telegram and Element show it. Pure, so the rules are tested without a window.
 *
 * Nothing is ever dropped or rewritten: a delimiter without a partner stays as typed, and a link
 * shows its own address, so a message cannot hide where a link goes. Block syntax (headings,
 * lists, quotes) is left alone: chat text is read as written.
 */

/** Escapes the characters Pango markup treats as syntax. */
export function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const URL_AT = /https?:\/\/[^\s<>"]+/y;
const TRAILING = /[.,;:!?'"\]]$/;
const DELIMITERS: ReadonlyArray<{ open: string; tag: string; word: boolean }> = [
  { open: '**', tag: 'b', word: false },
  { open: '~~', tag: 's', word: false },
  { open: '*', tag: 'i', word: true },
  { open: '_', tag: 'i', word: true },
];

const isSpace = (char: string | undefined): boolean => char === undefined || /\s/.test(char);
const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** The link at `at`, without the punctuation that ends a sentence rather than the address. */
function linkAt(text: string, at: number): string | null {
  URL_AT.lastIndex = at;
  const found = URL_AT.exec(text);
  if (!found) return null;
  let url = found[0];
  for (;;) {
    if (TRAILING.test(url) || (url.endsWith(')') && !url.includes('('))) url = url.slice(0, -1);
    else break;
  }
  // "https://" alone is not an address.
  return /^https?:\/\/[^/?#]+/.test(url) && url.length > 8 ? url : null;
}

/** The index of the closing `delim` for an opener, on the same line, or -1. */
function closerOf(text: string, from: number, delim: string, word: boolean): number {
  for (let k = from; k < text.length; k++) {
    const char = text[k] as string;
    if (char === '\n') return -1;
    if (!text.startsWith(delim, k)) continue;
    // A single `*` is not half of `**`.
    if (delim.length === 1 && (text[k + 1] === delim || text[k - 1] === delim)) continue;
    if (isSpace(text[k - 1])) continue;
    if (word && isWordChar(text[k + delim.length])) continue;
    return k;
  }
  return -1;
}

function inline(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === '`') {
      const end = text.indexOf('`', i + 1);
      const code = end > i + 1 ? text.slice(i + 1, end) : '';
      if (code && !code.includes('\n')) {
        out += `<tt>${escapeMarkup(code)}</tt>`;
        i = end + 1;
        continue;
      }
    }
    if (char === 'h' && !isWordChar(text[i - 1])) {
      const url = linkAt(text, i);
      if (url) {
        const shown = escapeMarkup(url);
        out += `<a href="${shown}">${shown}</a>`;
        i += url.length;
        continue;
      }
    }
    let matched = false;
    for (const { open, tag, word } of DELIMITERS) {
      if (!text.startsWith(open, i) || isSpace(text[i + open.length])) continue;
      if (word && (isWordChar(text[i - 1]) || text[i + open.length] === open)) continue;
      const end = closerOf(text, i + open.length + 1, open, word);
      if (end < 0) continue;
      out += `<${tag}>${inline(text.slice(i + open.length, end))}</${tag}>`;
      i = end + open.length;
      matched = true;
      break;
    }
    if (matched) continue;
    out += escapeMarkup(char);
    i++;
  }
  return out;
}

/** `text` as Pango markup; plain text comes back escaped and unchanged. */
export function richMarkup(text: string): string {
  return inline(text);
}

/** Whether `richMarkup(text)` differs from the escaped text, i.e. whether a label needs markup at all. */
export function hasRichText(text: string): boolean {
  return richMarkup(text) !== escapeMarkup(text);
}
