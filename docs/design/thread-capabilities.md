# Thread capabilities

Implements [ADR 0015](../adr/0015-capabilities-per-thread.md). The window asks "can *this thread*
react, edit, delete?", not "can *this backend*?".

## The layer

`packages/protocol/src/thread-capabilities.ts` is pure (no `gi://`, no `node:*`):

- `BackendCapabilities` (manifest) stays the **upper bound**.
- `ThreadFacts` is what is known of one thread: `backend`, `emailChat` (a mail peer sent
  `Chat-Version`), `self` (note to self). All but `backend` are optional.
- `threadCapabilitiesOf(capabilities, facts)` returns `ThreadCapabilities`: `reactions`, `edits`,
  `deletes`, `replies`, `attachments`, `readReceipts`. A backend's narrowing can only turn features
  off, never exceed the manifest. `threadCan(...)` answers one feature.
- Mail narrows by the peer: no `Chat-Version`, no reaction, edit, delete or read receipt. Every other
  backend answers with its manifest.
- XMPP narrows per JID in a direct chat (`narrowXmppThread`): a reaction (XEP-0444), a correction
  (XEP-0308) and a retraction (XEP-0424) are offered only when the peer advertised
  `urn:xmpp:reactions:0`, `urn:xmpp:message-correct:0` or `urn:xmpp:message-retract:1` in disco.
  The sync asks (`XmppApi.features`), stores the answer in `chat_cursors.peer_features` (schema v20)
  and the list entry carries it as `ThreadFacts.peerFeatures`. No answer is unknown and offers
  nothing; rooms keep the manifest; replies and files are not affected.

Voice notes and stickers (`Chat-Voice-Message`, `Chat-Duration`, `Chat-Content: sticker`) are read from the headers
and written on send only when `emailChat` is true; the index keeps them in `messages.chat_content` and
`chat_duration_ms` (schema v20), and `loadAttachments` types the audio part as `voice`. A missing
`Chat-Duration` is not an error.

The facts come from the list entry the window already holds (`emailChat` is written to the index by
the sync), so nothing is computed per bubble and no message is read.

## Rules for callers (A7–A11)

- Ask `threadCan(feature)` before showing an entry or control; never offer what the thread cannot do.
- `PINNED_FEATURES` (reaction, edit, delete for everyone, read receipt) address one existing message
  in its own network and are **never redirected** to another protocol; they are absent instead.
- Only new content (message, file) may go through the next protocol, and only when the person chose it.
- A backend that can narrow further (XMPP per JID, `XmppApi.features`) adds a `ThreadNarrowing` and
  extends `ThreadFacts`; new facts stay optional.

## Today

The mail manifest claims `reactions: true` (a reaction mail, `Content-Disposition: reaction`, RFC 9078), and `editsOwn/deletesOwn` (`Chat-Edit` / `Chat-Delete` mails, sent without angle brackets, parsed with or without). The mail narrowing gives reactions, edits and deletes to Delta Chat peers only: a plain mail thread has none, and none of them is ever redirected to another protocol. A deletion's local echo reappears at the next rebuild until the sent delete mail has synced back.

Replies (A9) are on: the mail manifest says `replies: true`, and the narrowing gives them to Delta Chat peers only. A mail reply names the message by its own id; the window threads it by `In-Reply-To`/`References`. The forward marker (`parseForwarded`, `packages/protocol/src/mail-forward.ts`) is read only for chat mail.
