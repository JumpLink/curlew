# ADR 0004 — sending and writing, granted per capability

- **Status:** Accepted (2026-10-10); amended 2026-10-10 and 2026-10-30, see
  [Amendment](#amendment-2026-10-10) and
  [Amendment 2026-10-30](#amendment-2026-10-30) and
  [Amendment (2026-10-30, telegram)](#amendment-2026-10-30-telegram) and
  [Amendment (2026-10-30, matrix)](#amendment-2026-10-30-matrix) and
  [Amendment (2026-10-30, signal)](#amendment-2026-10-30-signal) and
  [Amendment (2026-10-30, whatsapp)](#amendment-2026-10-30-whatsapp)
- **Scope:** `@gjsify/mcp` (the gate), `app` (config, MCP server, `curlew send`, `curlew daemon`),
  `@curlew/xmpp`, `@curlew/protocol` (calendar port), `@curlew/gnome` (EDS calendar driver)

## Context

Curlew is read-only by design. IMAP is read with `BODY.PEEK`, the chat backends refuse every
request that would send, and the MCP server registers a tool only when it declares
`readOnlyHint: true` (`applyReadOnlyGate` from `@gjsify/mcp`). Sending exists as a library
capability, `@curlew/smtp`, with no MCP tool and no CLI command. `AGENTS.md` says write access
for agents needs its own decision. werkstatt ADR 0001 §5 says the same for mail.

This is that decision. lotse's assistant (lotse ADR 0002) needs three things Curlew cannot do
today:

- **send** messages from the assistant's own XMPP account to its person,
- **receive** the person's replies quickly, not only on the next `curlew sync`,
- **create** calendar entries, without a duplicate when the same source is handled twice.

The person's own accounts are a different matter. A message sent from them speaks in the
person's name, so they must not send unless the person decided so for that account.

## Decision

### 1. Capabilities, granted in the configuration

A write is named as a **capability**: `<area>.<verb>`, bound to one target.

| Capability | Target | Allows |
|---|---|---|
| `xmpp.send` | an account and one address | sending messages from that account to that address, and the presence it needs |
| `calendar.create` | a calendar | creating events in that calendar |

Later capabilities (`mail.send`, `whatsapp.send` per contact, `calendar.update`) follow the same
form and get their row when they are built.

**`xmpp.send`'s target is an `<account>/<address>` pair**, the same shape the planned per-contact
`whatsapp.send` will have: the grant says from where *and* to whom. A send to any other address
is refused, so a granted account is not a licence to write to the person's whole roster. Presence
is the one thing the pair's **account** alone grants, because a connection carries one presence
per account and not one per contact.

Grants are a list in `config.json` (`grants: [{ capability, target }]`). The file is `state`;
grants are no secret. **A grant names exactly one target**: a wildcard, an empty target or an
unknown capability is a configuration error at load. Without a grant, today's behaviour holds
unchanged.

**The grant set is read once, at process start.** A running `curlew daemon` refuses to continue
when it changes — it stops and says that the grants were edited and that the new set applies on
restart. So a revocation takes effect on a restart the person performs, never halfway through a
connection that is already open, and the error says exactly that rather than leaving them to
wonder whether the old grant is still live.

### 2. The person's accounts send only with a grant for that account

There is no account role such as "assistant". An account sends when a grant names it and does
not send when none does. The assistant's account is simply the one with a grant. A grant for one
account never covers another. Read receipts, chat markers and typing notices are not sent, not
even on a granted account.

### 3. The gate moves from read-only to granted, and stays fail-closed

The gate becomes two checks.

- **At registration:** a tool registers if `readOnlyHint === true`, or if it declares a
  capability and at least one grant for that capability exists. A tool without annotations is
  still dropped. A write tool without a granted capability is still dropped.
- **At each call:** the target the call names must be one the grant lists. Otherwise the call is
  refused with an error that names the capability, never by silently doing nothing.

The call check is not a line every write tool remembers to write. **The same wrapper that
registers a capability tool applies it**: the handler is reached only after the call's target
matched the grant set, so a tool cannot be registered with the check left out. A forgotten check
is the one failure that looks exactly like a working gate.

The registration check is generic and goes into `@gjsify/mcp`. gjsify gets a gate that takes
the app's grant set; it holds no capability names (no central registry, lotse `AGENTS.md`).
Capability names and the call check stay in Curlew.

The canaries grow from two to four: the existing two (a tool with `readOnlyHint: false`, a tool
with no annotations) stay; a write tool whose capability is **not** granted must be absent; a
write tool whose capability **is** granted must be present. The fourth one is the positive
control: without it, a gate that drops everything passes the first three.

The positive control declares a **test-only capability, `canary.write`**, which `grants` accepts
only while `CURLEW_MCP_GATE_CANARY=1` and rejects as an unknown capability otherwise — so the
grant that proves the gate opens cannot be written into a real configuration. Its handler
performs no write at all: it proves that the call reached it, and nothing else.

### 4. Every frontend asks the same grant

`curlew send --account <a> --to <address> <text>` and the MCP tool `send_message` check the same
grant. The CLI is no back door: an agent with a shell can run it too.

### 5. XMPP: sending and a follow mode

- `@curlew/xmpp` gets a send path that exists only on a handle opened with the grant, in the
  same pattern as Signal's `guardedFetch`: the sync handle has no way to send.
- A sent message is written to the index as the account's own message. MAM's echo is matched by
  origin id (XEP-0359), so it is not stored twice.
- **Follow mode:** `curlew daemon` keeps a live connection for a granted XMPP account and writes
  arriving messages into the index through the same path as MAM. After a reconnect MAM fills the
  gap. A live session needs an available presence, which is why presence falls under
  `xmpp.send`. An account without a grant is not followed, only synced. The lease from ADR 0002
  §4 also covers follow mode.
- **The presence lasts exactly as long as the daemon.** It is sent when follow mode connects and
  ends when it stops; there is no status text, and the priority is negative, so the account
  stays reachable without presenting itself as the person at a desk and without pulling their
  other clients' messages to curlew. The write log records the moment it went available — it is
  the one thing the account's contacts can see, so it is not an invisible write.

### 6. Calendar: an interface, EDS now, CalDAV later

- `@curlew/protocol` gets a `CalendarBackend` port: list calendars, list events, create an event.
  Following werkstatt ADR 0004 (GNOME is optional), the first driver is EDS in `@curlew/gnome`,
  and CalDAV follows as a second driver without changing callers.
- **A created event carries a source key**: `<source>:<id>`, for example the backend and message
  id it came from, stored as an iCalendar property (`X-CURLEW-SOURCE`). Creating an event with a
  key that already exists in the target calendar returns the existing event and creates nothing.
  That is a check and then a write, not one atomic operation: **two creates with the same source
  key running at the same time may both succeed**. The source key makes a repeated handling
  idempotent, not a concurrent one, and the thing that keeps the second create from starting is
  the ADR 0002 §4 lease the writer holds — not the key.
- Only creating is decided. Changing and deleting events need their own capability and their
  own row in the table above.

### 7. Every write leaves a line

Each granted write appends one line to a write log in Curlew's data directory: time,
capability, target, frontend and the id of what was created or sent. No message text. Tier
`state`, declared in `.werkstatt-state.json`.

The line is appended **after** the write, because it carries the id the write returned and a log
written first would claim a send that never left. A write whose log line cannot be appended is
reported as a failure of that call — the write happened and its record did not, which the person
has to hear. No log failure is swallowed.

## Consequences

- `AGENTS.md` changes on acceptance: "no MCP tool that sends" becomes "no write without a grant",
  `@curlew/xmpp`'s "NEVER sends" becomes "never sends without a grant", and the canary rule
  names four canaries.
- The mail rule of werkstatt ADR 0001 §5 is unchanged until someone needs `mail.send`. Then it
  follows this record and gets its row.
- The config format gains a field, and an older build does not merely ignore it. `parseConfig`
  today returns only `{backends, senders}` and `saveConfig` writes that object back
  (`parseConfig` and `saveConfig` in `app/src/core/config.ts`), so an old build that *saves* the config erases the grants
  — it fails closed on reading and destructively on writing. **Decision:** `parseConfig` carries
  unknown top-level keys through unchanged and `saveConfig` writes them back, so a build that
  does not know a key cannot drop it. The builds already released still drop them: a known,
  one-time risk, and the reason this goes in before `grants` is written anywhere.
- The gate change is a published `@gjsify/mcp` contract. It goes to gjsify first, with its
  own tests, and Curlew picks it up with the version bump.

## Order of work

1. `@gjsify/mcp`: gate with a grant set, tests in both directions (gjsify, released first).
2. Curlew: config pass-through of unknown keys first, then `grants` in the config, validation, the call check, four canaries in `test:mcp`.
3. `@curlew/xmpp`: guarded send handle; `curlew send` and the MCP tool.
4. `curlew daemon`: follow mode for granted XMPP accounts.
5. `CalendarBackend` port, EDS driver with source keys, `calendar.create` (for lotse's school
   dates task).

## References

- werkstatt ADR 0001 §5 (sending is a library capability), werkstatt ADR 0004 (GNOME is optional)
- lotse ADR 0002 (the assistant in continuous operation)
- ADR 0002 (the receiving daemon and its lease)

## Amendment (2026-10-10)

The decision above stands. One part of its scope moved out of curlew:

- **`calendar.create` and the `CalendarBackend` write path (§6, step 5 of the order of work) now
  belong to the separate app [reminder](https://github.com/JumpLink/reminder).** Curlew is a
  messenger: it keeps contacts and messaging writes (`xmpp.send` and the later `*.send`
  capabilities) and no longer writes calendar events. The capability is removed from the
  grants table and from `CAPABILITIES`; a config that still lists it is rejected as an unknown
  capability.
- The read-only `curlew calendar` command is slated to move to reminder as well.

## Amendment 2026-10-30

Sending is no longer XMPP-only. Every backend gets a send path under the same rule:

- **One capability per backend: `<backend>.send`**, each with the `<account>/<address>` target
  §1 already specified. `xmpp.send` is simply the first; `mail.send` is the second. A config
  grant for one backend never authorises another.
- **The check lives once, in the app's send action**, not in each frontend and not in each
  backend. `curlew send` and the MCP `send_message` resolve the account to its backend, require
  a granted `<backend>.send` for the exact pair, and only then open the sender. The MCP gate
  still takes one capability per tool, so `send_message` is registered by the union of every
  `*.send` grant under an internal name that no config can spell; the exact backend check
  remains the action's.
- **Sending exists only on a handle opened with a permit** (`SendBackend.openSender` in
  `@curlew/protocol`), the pattern §5 already required for XMPP's `GrantedXmppSession` and
  Signal's `guardedFetch`. The permit lists the addresses granted for that account and the
  handle re-checks every one, so a bug above cannot widen a grant. The sync handle has no send
  method and no way to obtain one.
- **§7 is unchanged**: one write-log line per message, capability, target, frontend and the
  network's id — never the text.
- **Order of work:** mail, then Telegram, Matrix, Signal and WhatsApp, each getting its row in
  `CAPABILITIES` when its port is built. Until then an unknown `<backend>.send` is still a
  configuration error, not silently accepted.

The mail path sends one plain-text message over SMTP, with an optional subject, to the granted
address. Its credentials come from GNOME Online Accounts' SMTP purpose and appear in no log,
DTO, error or MCP result. Mail has no chat archive here, so a sent message is logged but not
indexed as a conversation.

## Amendment (2026-10-30, telegram)

`telegram.send` is built. Its target is `<account>/<chat id>` with the chat's remote id exactly as
the index and `conversations_list` show it (`String(peer.id)`): the positive user id of a direct
chat, the negative marked id of a group or channel, for example `telegram-42/1001`. It sends one
plain-text message of at most 4096 characters; a longer text is refused, never split, and there is
no image and no Markdown. The sender is opened only through `TelegramBackend.openSender`, which
keeps the full client handle; `TelegramApi` and the `ChatSession` that sync and the read tools
hold have no send method, and the sender re-checks its `SendPermit` before it touches the network.
The sent message is indexed as a local echo, and the next sync replaces it by its Telegram message
id (`ChatMessage.clientId` of your own messages).

## Amendment (2026-10-30, matrix)

`matrix.send` is built. Its target is `<account>/<room id>` with the room's remote id exactly as the
index and `conversations_list` show it, so the full `!room:example.org` including the colon, for
example `matrix-0123456789abcd/!room:example.org`. It sends one plain-text `m.room.message`
(`msgtype: m.text`) as a single `PUT …/rooms/{roomId}/send/m.room.message/{txnId}` with a fresh
transaction id per send; there is no Markdown and no image, and a body over 32000 UTF-8 bytes is
refused rather than split. **A room that carries `m.room.encryption` state is refused**: curlew
holds no Megolm sending path, and a cleartext event in an encrypted room would be a message the
room's members cannot read and a leak past the encryption they chose. The read guard stays closed —
`readOnlyFetch` still refuses every `PUT`, and the send endpoint is reachable only through the
separate `sendFetch` that `MatrixBackend.openSender` wraps around the permit's rooms, so the sync
and read handles have no way to send. The sent message is indexed as a local echo and the next sync
replaces it by its event id (`ChatMessage.clientId` of your own events).

## Amendment (2026-10-30, signal)

`signal.send` is built. Its target is `<account>/<ACI>` with the chat's remote id exactly as the
index and `conversations_list` show it — the peer's ACI, the bare UUID, for example
`signal-0b1c…/9f3a1c2e-…`. It sends one plain-text `DataMessage` of at most 2048 UTF-8 bytes
(Signal-Desktop's `MAX_MESSAGE_BODY_BYTE_LENGTH`); a longer body would need a long-message
attachment, which curlew does not upload, so it is refused rather than split. There is no
Markdown and no image.

**Groups are refused.** A group message needs the member list and the group's credentials from
Signal's storage service, which curlew does not sync, so a `group:<base64 id>` target is turned
away with that sentence rather than half-attempted.

**Sealed sender is not used.** Nothing in `@curlew/signal` fetches or stores a sender certificate,
so every copy goes out as an ordinary authenticated `PUT /v1/messages/{serviceId}`. The recipient
sees the sender, which Signal's own clients would hide.

**A send takes the receive lease.** The double-ratchet state lives in one secret file with no
lock, and the daemon loads it whole; two writers would leave the session somewhere neither side
can decrypt from, and no retry repairs a broken ratchet. So the app takes the same receive lease
the daemon takes (ADR 0002 §4) around the whole send, and a send while the daemon holds the
account is **refused** with the holder named and `curlew daemon stop` as the way out. A refusal
is the point: with the daemon running, every CLI send is refused, and the user stops it or sends
from their phone. The lease is taken in `app/src/core/actions/send.ts`, not in the backend — the
lease lives in the index, which `@curlew/store` must never let a backend reach — and which
backends need it is a new manifest field, `sendSharesReceiveState`. There is no heartbeat during
a send: a send is seconds and the lease goes stale after 90 s, so a send that hangs far longer
than that could in principle be overtaken.

**Two gates, not one.** The receive phase gate in `guard.ts` is unchanged and still knows no send
endpoint at all. The sender gets a *separate* guarded transport, built per permit, that allows
exactly `GET /v2/keys/{id}/{device|*}` and `PUT /v1/messages/{id}` and only for the ids the permit
names plus this account's own ACI — nothing else becomes reachable with a permit in hand, and the
receive session is handed no send channel.

**The fan-out is the message.** Every device of the recipient gets its own ciphertext, 409
(mismatched devices) and 410 (stale devices) are corrected by forgetting the affected sessions and
re-reading the server's device list, up to three times. Ratchet state is flushed only after a 2xx:
state the server rejected must not survive, or the recipient's next message is undecryptable. A
`SyncMessage.Sent` transcript then goes to this account's **other** devices so the message appears
on the phone; curlew excludes itself, as Signal-Desktop does. The transcript is best-effort — if
it fails the message still counts as sent and the gap is reported as `sendWarning`, because
failing the call would get the message sent twice on a retry. A note to self is the transcript
alone, and is refused when the account has no other device.

**A changed safety number is refused.** The receive path still trusts every identity (an arrived
message cannot be unsent), but sending to a key the user has not confirmed is exactly what a
safety number is for. The new key is stored before the refusal, so sending again is the
acknowledgement.

The sent message is indexed as a local echo whose id is `<own ACI>:<sent timestamp>` — what the
receive path uses as the remote id of your own messages — so a transcript that comes back from a
linked device replaces the echo (`ChatMessage.clientId`) instead of adding a second copy. Unlike
Matrix and Telegram this is a safety net rather than the normal path: Signal does not deliver a
transcript back to the device that sent it.

## Amendment (2026-10-30, whatsapp)

`whatsapp.send` is built. Its target is `<account>/<address>` with the chat's remote id exactly as
the index and `conversations_list` hold it — a full user JID, `<digits>@lid` or
`<digits>@s.whatsapp.net`, for example `whatsapp-2084…/1348…@lid`. It sends one plain-text message
of at most 65,536 UTF-8 bytes (WhatsApp's own text limit, read as bytes because a protobuf string
field is bytes on the wire); a longer text is refused, never split. There is no Markdown, no
attachment, no caption, no reaction, no edit and no quote.

**Only a full JID is an address.** A bare phone number is refused with the reason that a chat is
filed under the LID whenever curlew knows one, and a device suffix (`<user>:3@…`) is refused as
one device of a person rather than the person. Both forms are ambiguous about which row of the
index they mean, and the grant must name the same string a caller reads back. The sender sends to
the JID the permit names, normalized and otherwise verbatim: curlew does **not** rewrite a granted
phone-number JID to the LID it has learned for it, because a grant names one address. The local
echo is still filed under the chat id the index uses, resolved from the key Baileys hands back.

**Groups and broadcasts are refused.** A group message needs the sender-key fan-out over a member
list this package does not keep; `status@broadcast` is not a chat. Both are turned away by address
rather than half-attempted.

**A send takes the receive lease.** Baileys' auth state is one SQLite secret file with write-behind
and no lock, and WhatsApp allows one connection per linked device: a second socket while the daemon
holds the account draws `connectionReplaced` (440), and a race on that file is how a session gets
corrupted into a relink — which would cost the whole linked-device history. So `WHATSAPP_MANIFEST`
carries `sendSharesReceiveState: true` and `app/src/core/actions/send.ts` takes the same receive
lease the daemon takes (ADR 0002 §4) around the whole send; a send while the daemon holds the
account is **refused** with the holder named and `curlew daemon stop` as the way out. As with
Signal there is no heartbeat during a send.

**Two socket shapes, not one gate.** WhatsApp speaks one multiplexed WebSocket, so a send cannot be
fenced off by an HTTP allowlist the way Matrix's and Signal's are. The line is drawn at the handle
instead: `WaSocketHandle` (receive) has no send method at all and is not a supertype of
`WaSendSocketHandle` (send), so the sync and read path is not merely forbidden to send, it has
nothing to call. The one argument a sender still chooses — which chat — is gated per permit and
fail-closed in `guard.ts`, which `openSender` wraps around the socket before the sender sees it;
`WhatsAppSender.recipient` re-checks the permit as well.

**The fan-out is Baileys'.** `sendMessage` enumerates the recipient's and this account's devices,
fetches the pre-keys it has no session for, encrypts once per device, and wraps the copies for the
user's own devices in a `deviceSentMessage`, so the phone shows what curlew wrote. All of it leaves
in one stanza, so a throw means nothing went out. `linkPreview: null` keeps the send from fetching
any URL in the text. Not supported: a **retry request that arrives after the handle closed** —
`getMessage` is backed by an in-memory map that lives as long as the send session, so a peer whose
decryption failed later gets no resend from curlew, and asks the phone instead.

**An unconfirmed send is a warning, never a throw.** Baileys resolves `sendMessage` when the stanza
is written to the socket, which is not yet WhatsApp taking it; the sender waits up to 15 s for a
`messages.update` carrying `SERVER_ACK` for its own key and reports a timeout as `sendWarning`,
because failing the call would get the message sent twice by a caller that retries.

**The send socket receives, too.** The server hands it the offline queue like any other connection,
so it maps and journals everything it is given through the same `subscribeMapped` the receive path
uses, into the same account journal, and closes without releasing it. Without that, a message that
arrived during a send would be acknowledged to WhatsApp and then dropped. A journal failure before
the send refuses the send; one noticed after it is a `sendWarning`.

The sent message is indexed as a local echo whose id is the message id WhatsApp assigned — what the
receive path uses as the remote id of our own messages — so the copy the connection echoes back
replaces the echo (`ChatMessage.clientId`) instead of adding a second one. A note to self works the
same way and is recognised as our own through `key.fromMe`; it needs a grant naming this account's
own JID.
