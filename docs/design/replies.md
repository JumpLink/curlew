# Replies, quotes and reactions

Status: pieces 1 to 3 (quote, jump, send a reply for Matrix, Telegram and Signal) built. Reference: Fractal, Flare and Telegram show
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
| XMPP | XEP-0461 `<reply to id>` outside the OMEMO payload; `id` is the sender-given id (`conversation_messages.client_id`, schema v16), `to` the author's JID; a reply to a row without `client_id` is refused until a full scan of the chat adds it; files alone cannot carry a reply | built |
| Signal | `DataMessage.quote` with the sent timestamp and the author's ACI (both string and binary form), in the recipient copies and the transcript; no quoted text; direct chats only | built |
| WhatsApp | `quoted` with the key (id, `fromMe`) and the content (`conversation`), which the window passes as `ReplyTarget.text` (first 500 characters); direct chats only; a reply cannot carry files | built |
| Mail | threads through `inReplyTo`/`References` already, outside this flag | — |

Matrix needs no fallback text: the spec dropped reply fallbacks in v1.13.

The window part (built): `replyTo` travels through `SendParams`, `SendRequest` and the daemon
request (`DAEMON_WIRE_VERSION` 4, so an older daemon is refused with a restart hint rather than
dropping the link). The window needs to know whether a backend replies without opening a sender,
so the manifest carries `capabilities.replies` beside `features.replies`; the sender flag stays
the runtime gate. A reply always goes through the carrier of the message it answers (a link is
inside one network), and picking another carrier drops the reply. The bubble menu offers "Reply"
and "Copy"; Copy stays so touch users keep a way to copy text. The sent message is echoed with
its network id, so it shows its quote and can be answered too.

### 4. Reactions

Status: store, all five receive paths and the window chips built; sending is open.
Reference: Fractal and Flare show reactions as small emoji chips under the bubble,
with a count when more than one person used the same emoji; the person's own chip is tinted.

**Store.** Schema v17 adds `message_reactions (message_id, reactor, emoji, reacted_at)` with
primary key `(message_id, reactor)`: Signal and WhatsApp allow one reaction per person and
message, and a new one replaces the old. `reactor` is the same peer id `sender_peer_id` holds;
the person's own reaction uses the empty string. Matrix and Telegram allow several emoji per
person; they widen the key to `(message_id, reactor, emoji)` in their own step, and a replace
rule stays in the mapper (`replace: true`), not in the store.

**Change event.** One new `DeliveryChange`: `{ type: 'reaction'; chatRemoteId; remoteId;
reactor: string | null; emoji: string | null }`, where `reactor` is null for the person and a
null `emoji` removes the reaction. Like an edit it applies to a stored message, or to one
earlier in the same batch, and is dropped when the target is unknown. A deleted message drops its
reactions with it.

**Receive**, one backend per step: Signal (`DataMessage.reaction`: emoji, `remove`, target author
and sent timestamp; today `map.ts` drops it), WhatsApp (`reactionMessage` with the target key and
text, empty text = remove), then Matrix (`m.annotation`), Telegram (reaction counts per message,
which carry no reactor names, so only the chips and the count) and XMPP (XEP-0444). Until a
backend maps them its `capabilities.reactions` stays false.

**Window.** The page query loads the reactions of the visible messages in one second query. The
bubble shows one chip per emoji with a count (own tinted via `accent` style classes, no custom
CSS), wrapping in a `Gtk.FlowBox` under the text. Sending is a later step: an emoji row in the
bubble menu, `SenderFeatures.reactions`, and the daemon wire.

**Archive networks (Matrix, Telegram, XMPP).** They reach the store through `chat-sync.ts`, so a
reaction there is part of the page, not a change event:

- `ChatPage` gets `reactions?: ChatReaction[]` (`{ remoteId, reactor, emoji, eventId? }`) and the
  write phase applies them after the messages, dropping a reaction whose message is not stored.
- Matrix lets one person leave several emoji and XEP-0444 lists a person's full set per message,
  so the primary key widens to `(message_id, reactor, emoji)`. A delivery `reaction` change from
  Signal or WhatsApp then replaces the reactor's whole set for that message.
- Matrix takes a reaction back by redacting the annotation event, so `message_reactions` gets an
  optional `event_id` column; an archive page that redacts an annotation removes the row by it.
- Telegram reports counts per emoji and no reactors. It stores them under a synthetic reactor
  `telegram:<emoji>:<n>` per slot, and the chip shows the count without a "You" state unless the
  API flags the emoji as chosen.
  Built: the first reaction of a message carries `replaceAll`, because a page reports the whole
  state of the message, and one emoji keeps at most 100 placeholder rows. Custom and paid reactions
  are skipped. A page holds only messages newer than the cursor, so a reaction that arrives later
  on an already synced message shows up only when a full scan re-reads it.

Order: widen the key (schema v18), `ChatPage.reactions` plus the write phase, then Matrix, XMPP,
Telegram, one PR each.

**Sending.** `SenderFeatures.reactions` says a sender can react; `MessageSender.react(reaction)` is
present exactly then. A `SendingReaction` is `{to, target: ReplyTarget, emoji | null}`: a new emoji
replaces the person's earlier one on networks with one reaction per person, `null` takes it back.
The window calls `reactToMessage` (`actions/react.ts`), which asks the daemon first and else opens
a sender, like a send, but logs no message and indexes nothing: the echo is the window's own
store write, and the network's copy comes back through the receive path. The wire grows to v5 with
`DaemonSendRequest.reaction`, answered with `kind: 'sent'` and no steps; a request mixing a
reaction with text, an image, files or a reply target is refused. `capabilities.reactions` in the
manifest is read as "can send" for the window and stays false per backend until its sender exists.
Signal and WhatsApp groups are refused for sending, so reactions there are direct chats only.
Order: plumbing, Signal and WhatsApp senders, the UI (emoji row in the bubble menu, tapping the own
chip takes it back), then Matrix (`m.annotation`, removal needs the own event id), XMPP, Telegram.

### 5. Edit and delete

Separate specs; edit and delete need the server-archive and delivery-only differences written
down first.

## Out of scope

Threads and topics (`thread_remote_id`) stay a subject heading as today.
