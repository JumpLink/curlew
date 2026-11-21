/**
 * The normalised search key behind the window's message search.
 *
 * `gtk.js`, `gtk-js`, `gtk js` and `GTKJS` must find the same message, and `ä` must find `Ä`.
 * SQLite's `LIKE` folds only ASCII case and knows no punctuation, so both sides are reduced to
 * the same key in code: NFKD, combining marks dropped, lower-cased, and everything that is not a
 * letter, digit or symbol-picture removed. The stored form is `searchKey(subject, body)`; a
 * query is `normaliseSearchText(text)` and matched with `LIKE '%…%'` (the key never contains `%`
 * or `_`, so nothing needs escaping). Pure, so the app's in-conversation search shares it.
 */

const KEEP = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;
const MARKS = /\p{M}/gu;

/** One code point folded to the characters it contributes to a key (possibly none). */
function foldCodePoint(char: string): string {
  const folded = char.normalize('NFKD').replace(MARKS, '').toLowerCase().replace(/ß/g, 'ss');
  let out = '';
  for (const c of folded) {
    // toLowerCase can itself yield a mark (İ → i + U+0307), so the filter runs last.
    if (KEEP.test(c)) out += c;
  }
  return out;
}

/** The key form of `text`: folded, separators and punctuation removed. */
export function normaliseSearchText(text: string): string {
  let out = '';
  for (const char of text) out += foldCodePoint(char);
  return out;
}

/**
 * What a message row stores: subject and body each normalised, joined by a newline that no
 * normalised text contains, so a needle never matches across the seam.
 */
export function searchKey(subject: string | null | undefined, body: string | null | undefined): string {
  return `${normaliseSearchText(subject ?? '')}\n${normaliseSearchText(body ?? '')}`;
}

/** The `LIKE` pattern for a query, or null when it holds nothing searchable. */
export function searchPattern(text: string): string | null {
  const needle = normaliseSearchText(text);
  return needle === '' ? null : `%${needle}%`;
}

/**
 * Where the first (or every) match of a normalised needle sits in the ORIGINAL text, as
 * `[start, end)` UTF-16 offsets. Separators inside the match are part of the range.
 */
export function findSearchMatches(text: string, needle: string, all = false): Array<{ start: number; end: number }> {
  if (needle === '' || text === '') return [];
  let key = '';
  const origin: number[] = [];
  const endOf: number[] = [];
  let at = 0;
  for (const char of text) {
    const piece = foldCodePoint(char);
    for (let i = 0; i < piece.length; i++) {
      origin.push(at);
      endOf.push(at + char.length);
    }
    key += piece;
    at += char.length;
  }
  const found: Array<{ start: number; end: number }> = [];
  let from = 0;
  for (;;) {
    const i = key.indexOf(needle, from);
    if (i < 0) break;
    found.push({ start: origin[i], end: endOf[i + needle.length - 1] });
    if (!all) break;
    from = i + needle.length;
  }
  return found;
}
