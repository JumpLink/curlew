# Rich text in message bubbles

Status: built. Code: `app/src/window/rich-text-model.ts` (pure, tested), used by the bubble in
`app/src/window/conversation-view.ts`.

## Goal

Chat apps (Fractal, Telegram, Element, Signal) make links clickable and style a little inline
Markdown. Curlew's bubble was a plain label, so a link was dead text. The bubble now reads like
those apps without a Markdown engine and without ever changing what the sender wrote.

## Rules

- **Links**: `http://` and `https://` addresses. The label shows the address itself, so a message
  cannot hide where a link goes. Sentence punctuation (`.,;:!?'"]`) and an unbalanced closing
  `)` are not part of the link. No other scheme is linked (`javascript:`, `ftp:`, `file:`).
  The click goes through GTK's default handler, which opens it with `Gtk.show_uri` (the OpenURI
  portal in a sandbox).
- **Inline styles**: `**bold**`, `*italic*`, `_italic_`, `~~strike~~`, `` `code` ``. They nest, they
  never cross a line break, and a delimiter needs a non-space next to it on the inside. `*` and `_`
  also need a non-letter on the outside, so `snake_case_name` and `2 * 3 * 4` stay as typed.
  Code is literal, and a link is not styled inside.
- **Unmatched delimiters stay as typed.** Nothing is dropped or rewritten.
- **No block syntax**: headings, lists and quotes are not interpreted. A bridged message that
  carries its own formatting is shown as text.

## How it is shown

`richMarkup(text)` returns Pango markup. The view sets it with `set_markup` only when
`hasRichText(text)` is true, so plain messages take the old path. The markup is well-formed by
construction (every character escaped, every tag closed), so it is not pre-checked: `Pango.parse_markup`
does not know `<a>`, which `Gtk.Label` adds. The clamped preview ("Show more") and the full text go through
the same function.

## Not done

- Sending Markdown: `app/src/core/markdown.ts` already converts on the way out; the received side
  shows the same subset. Network-native formatting entities (Telegram, Matrix `formatted_body`) are
  not read yet.
- Mentions, hashtags, `www.` links without a scheme, and link previews.
