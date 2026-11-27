# ADR 0021 — a sent message is pending, then confirmed or failed

- **Status:** Accepted (2026-11-27) — the outgoing bubble appears before the network answers, and
  the swap is matched in the window, not in the index, as proposed.
- **Scope:** `app` (the window's composer and conversation pane, a new pure
  `window/pending-send-model.ts`), `app/src/core` (`actions/send.ts`, `actions/daemon.ts`,
  `lib/daemon-bus.ts` — wire v10), `@curlew/protocol` (`SendingMessage.clientId`,
  `SenderFeatures.clientIds`), `@curlew/xmpp` (the caller's id becomes the `origin-id`).
  **No schema change and no change to `@curlew/store`:** the echo scheme, `adoptLocalEchoes` and
  `deliveredTwin` already do what this needs, and `conversation_messages.client_id` — read into
  `ConversationMessage.clientId` since schema v16 — is what the client-id stage below matches on.
- **Builds on:** [ADR 0004](0004-sending-and-writing-granted-per-capability.md) (one send plan,
  the caller owns the log and the index), [ADR 0007](0007-live-updates-over-the-session-bus.md)
  (the daemon's `Changed` signal drives the refresh),
  [ADR 0010](0010-attachments-across-protocols.md) (one attachment descriptor),
  [ADR 0017](0017-media-thumbnails-at-sync.md) (a bubble paints from a local file before any fetch).

## Context

Until now the outgoing bubble appeared only after the send had finished. `onSend` disables the
composer, swaps the send button for a spinner, awaits `sendMessage`, and the message shows up on
the next page read. A WhatsApp send waits up to 15 s for the server's acknowledgement
(`DAEMON_SEND_TIMEOUT_MS` is 120 s for a reason), and a Signal send may first fetch pre-keys for
every device of the recipient. For that whole time the person has written something and the chat
shows nothing. On a slow link it reads as a lost message, and the honest reaction — press send
again — is the one that actually sends it twice.

Three facts about the existing machinery decide the shape of the answer.

**The index already has a local echo, and it is keyed by an id that only exists afterwards.**
`recordSentChatMessage` writes the sent message under `remote_id = local:<clientId>`, where
`clientId` is `SentMessage.id` — what the send *returned*. The next time the network's own copy
arrives, `adoptLocalEchoes` (live path) or the equivalent in `chat-sync.ts` matches it by
`clientId` and deletes the echo. That scheme is sound and this ADR does not touch it. But its key
is minted by the network, so it cannot name a message that has not been sent yet.

**Only XMPP carries an id the caller chose.** Every chat backend sets `ChatMessage.clientId` on
the person's own messages, but for Telegram, Signal, WhatsApp and Matrix it is a restatement of the
network's id (`remoteMessageId(chatId, message.id)`, `messageRemoteId(aci, sentAt)`,
`remoteMessageId(key.id)`, `event.eventId`). Only `packages/xmpp/src/map.ts` reports something the
sending side picked: `origin-id` (XEP-0359), minted by `GrantedXmppSession.newId`. So "give the
daemon a client id and match the delivered row by it" works on exactly one of six protocols. A
design that depends on it would be a design that works on XMPP and is decoration elsewhere.

**With a daemon running, the delivered row can land before the send call returns.** This is
already documented at `deliveredTwin`: the daemon's receive socket may write the network's copy
into the index before `sendMessage` returns, which is why the echo adopts that row instead of
being inserted beside it. The same race now has a second victim — an outgoing bubble the window is
showing itself.

## Decision

### 1. Three states, and they live in the window

A send is `pending`, then `confirmed` or `failed`. The state is held in the window's memory, in a
map keyed by a client id the window mints before it calls `sendMessage`. It is **not** written to
the index.

This follows the precedent of `PendingEdit` / `withPendingEdits`, which already lays an in-flight
edit over a page read from the index. The reasons are the same, and one more:

- The index is the record of what *happened*. A message that has not reached the network did not
  happen. Writing it would make every other reader of the index — the agent tools, `curlew
  conversations`, search, the notification path — see a message that may never exist.
- A pending row in the index would need removing again on failure, from a process that may have
  died; a crash would leave a permanent fake message in the history. In memory, a crash loses
  exactly what it should: an in-flight send whose outcome this process no longer knows.
- No write on the send path means no `openIndexDb` on the main loop to show the bubble.

What this costs is stated plainly: **close the window mid-send and the pending bubble is gone.**
The send itself is unaffected — it is the daemon's or the process's own promise — and its result
reaches the index as it always did. Nothing is lost but the display of it. A failed send whose
window is closed is likewise forgotten rather than offered for retry. Persisting either would mean
an outbox, which is §9.

### 2. The client id, and what it is for

The window mints a UUID per send and hands it down: `SendParams.clientId` →
`SendRequest.clientId` → `SendingMessage.clientId`, and over the bus as
`DaemonSendRequest.clientId`, echoed back on every `DaemonSendStep.clientId`.

Its job is **correlation inside the window**: which pending entry a result or a freshly read row
belongs to. That job does not need the network's cooperation, which is what makes it work on all
six protocols.

Where the protocol does carry a caller-chosen id, the sender uses it, and then the id is also an
exact match against the delivered row. `SenderFeatures.clientIds` says who does:

| Protocol | A caller-chosen id on the wire | What the sender does with it |
|---|---|---|
| **XMPP** | yes — `origin-id` (XEP-0359), already minted per send | uses it; `clientIds: true` |
| **Matrix** | yes in principle — the transaction id | not used: the mapper reports `event.eventId`, so it would not come back. `clientIds` unset |
| **Telegram** | no — `random_id` is deduplication only, never readable back | ignored |
| **WhatsApp** | no — the message key id is the network's | ignored |
| **Signal** | no — a message is named by its send timestamp | ignored |
| **Mail** | no — and see §6 | ignored |

A sender that does not claim `clientIds` is still *given* the field and must ignore it. That is
deliberate: the field's meaning is "the caller's name for this send", and a backend that later
gains a use for it changes one flag.

### 3. Matching, in two stages, and only among sends in flight

The pending bubble is removed when — and only when — its real row is on screen, or the send's own
promise has answered. Two keys are tried in this order, both pure functions of the page and the
pending map (`settledByPage` in `window/pending-send-model.ts`):

1. **By client id.** When the page holds a row whose `clientId` equals the pending entry's, it is
   the same message. Exact, and available before the send returns — this is the stage that closes
   the daemon race on XMPP.
2. **By content, bounded to the in-flight set.** A row in the target conversation with
   `fromSelf`, the same body text, the same attachment count, and a `sentAt` inside the window
   below, which no other pending entry has already claimed.

There is deliberately **no stage keyed on `SendResult.messageId`**. An earlier draft had one, and
it was dead by construction: the only moment the window learns that id is when `sendMessage`
resolves, and that is the same moment it drops the entry and appends the real message itself. A
stage that can only fire after its input disappears is not a stage — so the resolved path is
described in §3.1 below instead, and the matcher has two keys.

**The time bound, and why it is not an equality on `startedAt`.** `startedAt` is this machine's
clock with milliseconds. A delivered row's `sentAt` is the *server's*, and Telegram and WhatsApp
report it truncated to whole seconds. A row that really is this send can therefore carry a stamp
*earlier* than the send started — by up to a second from the truncation alone, plus whatever the
two clocks disagree by. A strict `sentAt >= startedAt` would leave such a row unmatched, and the
chat would show the pending bubble beside the real message until the send's own promise resolved:
a transient duplicate, which is exactly what this ADR exists to prevent.

So the stage floors `startedAt` to the second and subtracts a skew window of
**`SEND_CLOCK_SKEW_MS` = 5 s**. Wide enough for a truncated stamp plus an unsynchronised clock,
narrow enough that the never-reach-into-history property holds: the stage only ever sees the page
beside the sends currently in flight, and a send lives for seconds, so five seconds of slack
cannot reach a message from an earlier conversation turn. A row stamped further back than the
window — real history — still does not match.

The content stage is what closes the daemon race on the five protocols that cannot echo a client id, and the bound
is what makes it safe: only that one conversation, only the person's own rows, only while a send is
in flight, each row claimed by at most one entry. The failure mode left is sending the identical
text twice within the same send's lifetime, where the second pending bubble may settle against the
first message's row — a swap one message too early, never a duplicate and never a loss.

#### 3.1 The resolved send, and why it cannot append twice

Both directions of the race end in one row on screen:

- **Echo after ack** (no daemon, or the reply wins): `sendMessage` resolves. The entry is still in
  the map, so the window drops it — bubble and temporary files — and appends the message the result
  describes (`id = SendResult.originId`, which is the `clientId` the index row was written under).
  A later page read finds that same id already shown, so `liveChanges` reports it as neither added
  nor removed.
- **Ack before echo** (the daemon's socket wrote the delivered row first): the refresh that brings
  that row settles the entry by either stage and the real row takes the bubble's place. When the
  send's promise then resolves, the entry is **gone from the map** — the `.then` reads
  `pendingSends.get(clientId)`, finds nothing, and returns without appending. That guard is the
  whole reason the resolved path does not need a stage of its own.

### 4. The bubble

A pending message is a normal own bubble with the accent colour, built by the same `addRow` from a
synthetic `ShownMessage` whose id is `pending:<clientId>`. It is not a separate widget tree: a
second rendering path for outgoing messages would drift from the first, and the swap would be
visible as a relayout.

- **Text** is shown as written.
- **Media** paints from the file the person picked, by path, with no fetch — the picture is
  already on their disk (and `PickedFile` already holds the path the composer will send).
- Below it, in place of the clock, a dimmed **"Sending…"** label, and after the stall budget a
  small spinner. The label is the accessible name too, so a screen reader announces the state
  rather than an empty time.
- On failure the label becomes **"Not sent"** with an error style, and the bubble's menu gains
  **Retry** and **Delete**. A toast carries the sentence the backend gave, once.
- On confirmation the synthetic row is dropped in the same `update` pass that adds the real one,
  so the list goes from pending bubble to confirmed bubble with no intermediate state and no
  scroll jump.

The composer is released as soon as the pending bubble exists, not when the send returns: the
person can write the next message while the first is in flight. This is the visible half of the
change and the reason the spinner-on-the-send-button goes away.

### 5. Retry and discard

**Retry** re-sends with the **same client id**. On XMPP that means the same `origin-id`, so a
message that did reach the server and whose acknowledgement was lost is recognised as the same
message by the archive rather than stored twice. On the other five it is a genuine second send,
and the ADR does not pretend otherwise: where the first attempt may have gone out, a retry may
duplicate it. That is why retry is a button the person presses and never something automatic —
curlew does not decide on their behalf to risk a double message. `SentMessage.warning` already
exists for the related case (delivered, but something around it failed) and is shown as a toast on
a *confirmed* message, not as a failure.

**Delete** drops the pending entry and its files. It makes no claim about the network: the label
is the composer's, not the protocol's, and the ADR is explicit that discarding a failed send whose
bytes may already have left is removing it from *this screen*. A send that actually did go out
reappears on the next sync, as any sent message does.

Neither button is offered while the entry is `pending`. There is no cancel: none of the six
transports can withdraw a send in progress, and a button that sometimes does nothing is worse
than no button. A send that never answers stays pending until its timeout turns it into a failure
(§7).

### 6. Mail has no local echo, so a pending mail bubble ends at the promise

`SendResult.conversationId` is absent for mail by design: the sent copy is filed in the Sent
mailbox and indexed by the next sync, so there is no row to match and both stages of §3 have
nothing to work with. A pending mail send is therefore settled by its own promise — resolved removes the
bubble, rejected marks it failed — and the message appears when the mailbox is next read.

For the Delta Chat case (a mail thread shown as a chat, ADR 0014) that is a visible gap between
the bubble vanishing and the synced copy arriving. It is accepted rather than papered over: the
alternative is a mail-only echo row, which is a second echo scheme for one protocol.

### 7. Timeouts, restarts and the stall budget

- A send that does not answer within `DAEMON_SEND_TIMEOUT_MS` fails with the sentence the bus
  layer already produces, which says that something may still have been sent.
- A **daemon restart mid-send** rejects the D-Bus call; the entry fails and offers retry. A
  **wire mismatch** (`DaemonWireMismatchError`) fails it with the existing restart message and is
  not retried through the same door — this is the fail-closed path from ADR 0007, unchanged.
- The pending bubble is built on the main loop and must not cost more than the 50 ms budget: one
  synthetic row through the existing `update` path, no database open, no image decode beyond the
  thumbnail the picture widget already does asynchronously.

### 8. Wire v10

`DAEMON_WIRE_VERSION` goes 9 → 10. `clientId` is required on a send request and on every step of
a `sent` reply, so an older daemon talking to a newer window — or the reverse — is refused by the
existing version check rather than silently dropping the correlation key and leaving a pending
bubble that can only be settled by content. Fail closed, as every previous field addition did.

### 9. Out of scope

- **A persistent outbox.** A send that survives closing the window, with its files, retried on
  the next start. It is the natural next step and it is a different ADR: it needs a table, a
  lifecycle, a policy for how long to keep trying, and an answer for files the person has since
  deleted.
- **Delivery and read receipts as bubble ticks.** Confirmed here means "the network took it", not
  "the peer got it". `peer_read` already exists and is a separate feature.
- **Per-attachment upload progress.** The bubble shows that a send is in progress, not how many
  bytes of a 40 MB video have gone. The senders do not report progress today, and inventing it
  per backend is its own piece of work.
- **Queueing.** Sends are not serialised; two in flight are two pending bubbles.

## Consequences

The person sees their message the instant they press send, on every protocol, and can keep
writing. A failure is visible where the message is, with the two actions that make sense there,
instead of a toast about a message that was never shown.

The cost is that pending state is per-window and per-run. Closing the window during a send loses
the bubble but not the send; a failed send is not remembered across restarts. Content matching
accepts one narrow misattribution (the same text sent twice inside one send's lifetime) in
exchange for closing the duplicate window on five of six protocols.

`clientIds` is a capability flag with one backend behind it. That is honest rather than
embarrassing: it marks the exact place where XMPP's `origin-id` buys an exact match, and gives
Matrix a one-flag path to the same if its mapper is ever changed to report the transaction id.
