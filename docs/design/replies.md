# Replies, quotes and reactions

Status: piece 1 (show the quoted message) built. Reference: Fractal, Flare and Telegram show
the message a reply points at as a small block above the reply's text. The index already stores
the pointer (`reply_to_remote_id`, `reply_to_client_id`) for Telegram, Matrix, XMPP, Signal and
WhatsApp, and nothing in the window reads it.

## Goals

- A reply reads as a reply: the quoted author and a short excerpt sit above the text.
- Then the person can reply, react, edit and delete from the window, in that order.
- A feature a protocol lacks is hidden, not greyed out (`features.reactions` and the like).

## Pieces, in this order

### 1. Show the quote (receive side, no wire change)

`quoteOf(message, loaded)` is pure. It finds the quoted message among the messages already in
the view by `ref.remoteId === replyToRemoteId` and returns the author ("You" for the person's
own message) and an excerpt: the first non-empty line of the text clipped to 140 characters, or
the first attachment line when there is no text. A quote whose target is not loaded (older than
the page) shows nothing yet; the pointer is kept.

The block is a left bar, the author in `caption-heading`, the excerpt in `caption`, two lines at
most, using theme colours only (a `Gtk.Box` with the `card`-free `dim-label` look, no custom CSS
for structure). It is not interactive in this piece; jumping to the quoted message is piece 2.

### 2. Jump to the quote

Pressing the block scrolls to the quoted row and centres it (built). A click gesture, not a
button: a button's padding would indent the quote against the text. A target older than the loaded
page is not looked up yet, so such a reply shows no quote at all; resolving it needs a lookup by
remote id in the store, then the same jump after loading pages.

### 3. Send a reply

A "Reply" action on a bubble (long press on touch, context menu on a pointer) sets a reply bar
over the composer. The send path carries `SendingMessage.replyTo` (`{ remoteId }`) to the backend.
A sender that cannot reply has `features.replies = false` and is never handed a target; the window
hides the entry. Built in two steps: the backends first, then the window.

| Protocol | Wire shape | State |
|---|---|---|
| Matrix | `m.relates_to` → `m.in_reply_to` → `event_id` on the `m.room.message`; on the first file only | built |
| Telegram | mtcute `replyTo` message number of the same chat (`<chat>/<number>`); a target of another chat is refused; first file only | built |
| XMPP | XEP-0461 `<reply to id>` | to do |
| Signal | `quote` in the data message (timestamp, author, text) | to do |
| WhatsApp | `contextInfo.quotedMessage` with key and content | to do |
| Mail | threads through `inReplyTo`/`References` already, outside this flag | — |

Matrix needs no fallback text: the spec dropped reply fallbacks in v1.13.

### 4. Reactions, then edit and delete

Separate specs; reactions need an index table (`message_reactions`), edit and delete need the
server-archive and delivery-only differences written down first.

## Out of scope

Threads and topics (`thread_remote_id`) stay a subject heading as today.
