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

### 2. Jump to the quote, fetch an older target

Pressing the block scrolls to the quoted row and flashes it; when the target is older than the
loaded page, load pages until it appears or give up after a bounded number.

### 3. Send a reply

A "Reply" action on a bubble (long press on touch, context menu on a pointer) sets a reply bar
over the composer. The send path carries `replyTo` to the backend; backends that cannot reply
ignore the bar and the menu entry is hidden. Needs a spec for each protocol's wire shape.

### 4. Reactions, then edit and delete

Separate specs; reactions need an index table (`message_reactions`), edit and delete need the
server-archive and delivery-only differences written down first.

## Out of scope

Threads and topics (`thread_remote_id`) stay a subject heading as today.
