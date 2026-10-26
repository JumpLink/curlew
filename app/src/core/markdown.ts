/**
 * Markdown as a chat shows it, and the quote lines of a reply — pure, no I/O.
 *
 * An agent answers in Markdown; an XMPP client renders none of it. XEP-0393 (message styling) is
 * what Conversations, Gajim and Monocles understand: `*bold*`, `_italic_`, `` `code` ``, `> quote`,
 * fences. So headings and `**x**` become `*x*`, `*x*` becomes `_x_`, list markers become "• " and
 * a link `[t](url)` becomes "t: url" — the URL stays complete, because the client makes it clickable.
 *
 * A line that is only `![alt](https://…)` splits the message: the text before it, the image, then
 * the rest, in order. The image goes out as its own message (XEP-0066), see `send.ts`.
 *
 * Ported from Lotse's `xmpp-style.ts` and `stripQuote` (the protocol knowledge lives here now).
 */

export type Segment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly url: string; readonly alt: string };

/** Longest text part curlew sends as one message; XMPP refuses more than 8000 characters. */
export const MAX_CHUNK_CHARS = 7000;

/** Images per call; further ones stay as plain links. */
export const MAX_IMAGES = 8;

export const MESSAGE_FORMATS = ['plain', 'markdown'] as const;
export type MessageFormat = (typeof MESSAGE_FORMATS)[number];

const IMAGE_LINE = /^\s*!\[([^\]]*)\]\((https:\/\/(?:[^\s()]|\([^\s()]*\))+)\)\s*$/;
const IMAGE_INLINE = /!\[([^\]]*)\]\(((?:[^\s()]|\([^\s()]*\))+)\)/g;
/** Stands in for a finished bold marker, so the italic pass does not read it as `*x*`. */
const BOLD = '\uE000';
const LINK = /\[([^\]]+)\]\(((?:[^\s()]|\([^\s()]*\))+)\)/g;

function linkText(label: string, url: string): string {
  const text = label.trim();
  return text === '' || text === url ? url : `${text}: ${url}`;
}

/** The inline Markdown of one line, outside code spans. */
function inline(line: string): string {
  return line
    .split(/(`[^`\n]*`)/)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .replace(IMAGE_INLINE, (_all, alt: string, url: string) => linkText(alt, url))
        .replace(LINK, (_all, label: string, url: string) => linkText(label, url))
        .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, `${BOLD}$1${BOLD}`)
        .replace(/__(?=\S)(.+?)(?<=\S)__/g, `${BOLD}$1${BOLD}`)
        .replace(/(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '_$1_')
        .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '~$1~')
        .replaceAll(BOLD, '*');
    })
    .join('');
}

function styleLine(line: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) {
    const title = inline(heading[1]!).replace(/^\*(.+)\*$/, '$1');
    return title === '' ? '' : `*${title}*`;
  }
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return '';
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}• ${inline(bullet[2]!)}`;
  const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
  if (quote) return `> ${inline(quote[1]!)}`;
  return inline(line);
}

/** Break `text` into chunks of at most `max` characters, preferably at blank lines, then newlines. */
export function chunk(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max / 2) cut = window.lastIndexOf('\n');
    if (cut < max / 2) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== '') out.push(rest);
  return out.filter((part) => part !== '');
}

/** `markdown` as the XMPP messages to send, in order. `maxImages` is the cap per call. */
export function renderForXmpp(
  markdown: string,
  maxImages: number = MAX_IMAGES,
  maxChunk: number = MAX_CHUNK_CHARS,
): Segment[] {
  const segments: Segment[] = [];
  let pending: string[] = [];
  let images = 0;
  let fence = false;

  const flush = () => {
    const text = pending
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    pending = [];
    for (const part of chunk(text, maxChunk)) segments.push({ kind: 'text', text: part });
  };

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      pending.push(line.trim());
      continue;
    }
    if (fence) {
      pending.push(line);
      continue;
    }
    const image = IMAGE_LINE.exec(line);
    if (image) {
      if (images < maxImages) {
        images += 1;
        flush();
        segments.push({ kind: 'image', url: image[2]!, alt: image[1]! });
      } else {
        pending.push(linkText(image[1]!, image[2]!));
      }
      continue;
    }
    pending.push(styleLine(line));
  }
  flush();
  return segments;
}

/**
 * Markdown as plain text, for a network without message styling: markers are removed, a link
 * becomes "label: url", a list keeps its "• ". Long texts are split like the XMPP rendering.
 */
export function renderPlainText(markdown: string, maxChunk: number = MAX_CHUNK_CHARS): string[] {
  const lines: string[] = [];
  let fence = false;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      lines.push(line);
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    const source = heading ? heading[1]! : line;
    if (!heading && /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
    const bullet = heading ? null : /^(\s*)[-*+]\s+(.*)$/.exec(source);
    const text = (bullet ? bullet[2]! : source)
      .replace(IMAGE_INLINE, (_all, alt: string, url: string) => linkText(alt, url))
      .replace(LINK, (_all, label: string, url: string) => linkText(label, url))
      .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
      .replace(/__(?=\S)(.+?)(?<=\S)__/g, '$1')
      .replace(/(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1')
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
      .replace(/`([^`\n]*)`/g, '$1');
    lines.push(bullet ? `${bullet[1]}• ${text}` : text);
  }
  return chunk(
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    maxChunk,
  );
}

/**
 * The reply's text without its quoted lines: every line that starts with `>` (an XEP-0393 quote,
 * which is also what a client's reply fallback looks like), and the blank line after a leading
 * quote block. Text without a quote is returned as it came, and a message that is only a quote
 * stays as it is — an empty body would hide that the person answered.
 */
export function stripQuotes(text: string): string {
  const lines = text.split('\n');
  if (!lines.some((line) => line.startsWith('>'))) return text;
  const kept: string[] = [];
  let afterQuote = false;
  for (const line of lines) {
    if (line.startsWith('>')) {
      afterQuote = kept.length === 0;
      continue;
    }
    if (afterQuote && line.trim() === '') {
      afterQuote = false;
      continue;
    }
    afterQuote = false;
    kept.push(line);
  }
  const rest = kept.join('\n');
  return rest.trim() === '' ? text : rest;
}
