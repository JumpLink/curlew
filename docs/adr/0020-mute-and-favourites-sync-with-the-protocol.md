# ADR 0020 — mute and favourites sync with the protocol where it has them

- **Status:** Proposed (2026-11-22). Decided by Pascal in chat; the choices below are the agreed
  shape. No code in this change.
- **Scope:** `@curlew/store` (schema v30, a flags table), `@curlew/protocol` (two manifest flags,
  the per-thread narrowing), the backends that can carry it (`@curlew/telegram`,
  `@curlew/matrix`, `@curlew/whatsapp`), `app` (config, the daemon route, the notice decision, the
  conversation list). Issues [#485](https://github.com/JumpLink/curlew/issues/485) (mute) and
  [#484](https://github.com/JumpLink/curlew/issues/484) (favourites).
- **Builds on:** [ADR 0001](0001-multi-protocol-messenger.md) (backends behind one port),
  [ADR 0004](0004-sending-and-writing-granted-per-capability.md) (every write passes a gate;
  amendment 2026-10-30 daemon send), [ADR 0015](0015-capabilities-per-thread.md) (capabilities are
  per thread), [ADR 0007](0007-live-updates-over-the-session-bus.md) (the change journal).

## Context

Two features want the same thing: a per-conversation flag the person sets, that the **daemon** can
read (it decides notifications, `app/src/core/lib/message-notices.ts`) and that does not disappear
when a sync rewrites the conversation row.

Curlew has the precedent for exactly this shape. The person's read position is local
(`conversation_read_state`, schema v26, `packages/store/src/schema.ts:495`) **and** pushed to the
networks that have a private form, behind one setting, over one daemon route
(`app/src/core/actions/read-sync.ts`, `SyncRead` on the bus, `daemon-bus.ts:46`). Mute and
favourites are the same problem with a different payload, so they take the same road rather than a
second one.

What the networks actually offer, read in our own code (no `node_modules` in the worktree; the
library pins are the `package.json` versions):

- **Telegram** (`@mtcute/core` 0.32.3): MTProto carries both — `notifySettings` and `pinned` on a
  dialog, `account.updateNotifySettings` and `messages.toggleDialogPin` to write, with `mute_until`
  as an absolute instant. Our port surfaces neither: `TgDialog`
  (`packages/telegram/src/api.ts:115`) has peer, last message and the two read marks, and
  `TelegramApi` (`:140`) has no write method at all.
- **Matrix** (`matrix-js-sdk` 42.4.0): mute is a push rule on the room, favourite is the `m.tag`
  `m.favourite` (with an `order`). Both read and write exist in the SDK; our package uses neither —
  a grep for push rules and tags in `packages/matrix/src` finds nothing, and `MxRoom`
  (`packages/matrix/src/api.ts:52`) carries only `readUpToTs`. There is no pin limit and no mute
  expiry.
- **WhatsApp** (`baileys` 7.0.0-rc14): `chatModify` carries both (`{ mute: <ms> | null }`,
  `{ pin: true | false }`) and `chats.upsert` / `chats.update` report them
  (`packages/whatsapp/src/events.ts:65`). Two obstacles: `WaChat`
  (`packages/whatsapp/src/api.ts:145`) drops the fields, and `chatModify` is deliberately absent
  from both socket handles — the receive handle cannot write at all and the granted send handle's
  writes are exactly six message methods (`packages/whatsapp/src/guard.ts:7`).
- **Signal** (`@signalapp/libsignal-client` 0.103.0): mute and pinned conversations live in the
  **storage service** manifest. Our gate is fail-closed and allows link requests, envelope
  acknowledgements and one `GET /v2/groups` on the storage host
  (`packages/signal/src/guard.ts:191`, `:198`) — nothing else reaches libsignal. Reading that
  manifest means implementing its record crypto and widening the gate; neither is in this ADR.
- **XMPP**: no standard per-chat mute. Bookmarks (XEP-0402 `urn:xmpp:bookmarks:1`,
  `packages/xmpp/src/stanza.ts:35`; legacy XEP-0048 at `:37`) are a MUC **auto-join list**, not a
  favourite and not a star on a 1:1 chat. Reusing them would mean joining and leaving rooms as a
  side effect of a star.
- **Mail** (`@curlew/imap`): nothing per conversation. IMAP flags are per message, and a mail
  conversation is synthesized by curlew, not by the server.

## Decision

### 1. One table, two flags, local first

Schema **v30** adds `conversation_flags` — a table, not columns on `conversations`, for the v26
reason: the mail rebuild replaces every conversation row and a sync rewrites it, so nothing a sync
writes may hold state that only exists here.

```sql
CREATE TABLE IF NOT EXISTS conversation_flags (
  conversation_id        TEXT PRIMARY KEY,
  muted                  INTEGER NOT NULL DEFAULT 0,
  muted_until            TEXT,              -- absolute ISO instant; NULL with muted=1 = until unmuted
  muted_at               TEXT,              -- when the person set it here
  favourite              INTEGER NOT NULL DEFAULT 0,
  favourite_at           TEXT,
  mute_pending_at        TEXT,              -- non-NULL: a local write is not acknowledged yet
  favourite_pending_at   TEXT,
  remote_muted           INTEGER,           -- last state the network reported; NULL = never seen
  remote_muted_until     TEXT,
  remote_favourite       INTEGER,
  remote_at              TEXT)
```

`CREATE INDEX conversation_flags_favourite ON conversation_flags (favourite)`. Every write appends
a `conversations` change row (ADR 0007) so the window and the daemon see it without polling.

The local flag is the truth the UI and the daemon read. The network half is a mirror, never a
prerequisite: a thread whose protocol has no mute is still mutable, in curlew, and the UI **says
which** — "muted everywhere" versus "muted in curlew" — because a silent local-only fallback is the
thing [#485](https://github.com/JumpLink/curlew/issues/485) rules out.

### 2. Capability table

| Protocol | mute read | mute write | mute-until | pin read | pin write | pin limit |
|---|---|---|---|---|---|---|
| Telegram | yes (dialog `notifySettings`) | yes (`account.updateNotifySettings`) | yes, absolute | yes (dialog `pinned`) | yes (`messages.toggleDialogPin`) | yes — read `pinned_dialogs_count_max` from the app config (5 free, 10 Premium), never hardcode |
| Matrix | yes (push rules) | yes (push rules) | no — local timer | yes (`m.tag` `m.favourite`) | yes (tag with `order`) | none |
| WhatsApp | yes (`chats.update`) | yes (`chatModify {mute}`) | yes, duration | yes (`chats.update`) | yes (`chatModify {pin}`) | yes, small (3 in the app) — verify at implementation |
| Signal | no (storage service not implemented, gate closed) | no | — | no | no | — |
| XMPP | no | no | — | no (bookmarks are a join list) | no | — |
| Mail | no | no | — | no | no | — |

Signal, XMPP and mail are therefore **curlew-local only** for both flags. Signal is the one worth
revisiting later, as its own decision: it has the state, we have no decoder and a gate that must
stay fail-closed.

### 3. Sync is on by default, one setting, both directions

`ui.syncChatFlags` (default `true`), the shape of `ui.syncReadState`
(`app/src/core/actions/read-sync.ts:33`). On: a local change is pushed, a remote change is applied.
Off: nothing is pushed and no remote change is applied — and **nothing already pushed is withdrawn**,
because an unmute the person did not ask for is worse than a stale one. The sync keeps filling the
`remote_*` columns while off (it arrives in the dialog list anyway), so turning it back on shows a
difference instead of silently overwriting one; the first change after that is resolved by §4.

### 4. Echo loop and conflicts, per field

Mute and favourite are resolved independently. A local write sets its column and its
`*_pending_at`, then asks the network. Then:

1. The network reports the state we wrote → that is our own echo: clear `*_pending_at`, write
   `remote_*`, change nothing else.
2. The network reports a different state **while pending** → the local write wins; it is retried
   **once**, and if the network still disagrees the remote value is taken and `*_pending_at`
   cleared. Bounded on purpose: no ping-pong, and the last state is the network's, which is the one
   the person's phone shows.
3. Nothing pending → the remote value is applied, last-writer-wins by `remote_at` against
   `muted_at` / `favourite_at`. Timestamps are our own clock; the networks here do not carry a
   change time, which is why pending state and not a timestamp decides case 2.
4. `muted_until` is stored as an absolute instant. Where the protocol has no expiry (Matrix), the
   timer is local: the daemon unmutes when it passes and pushes the unmute then.

### 5. The write takes the daemon route

Mute and pin writes go the road of a reaction and a read sync: the daemon that holds the account
first, else a sender of our own (`read-sync.ts:9`). WhatsApp and Signal share receive and send state
(`sendSharesReceiveState`), so a second process cannot write while a session is open.

That needs a new `SetChatFlags` method on the daemon interface (`daemon-bus.ts:33`) and, for
WhatsApp, `chatModify` added to the granted-send handle — an ADR 0004 widening with its own test
naming the method and the reason, in that package's gate comment.

**`DAEMON_WIRE_VERSION` goes 8 → 9, in the increment that adds the method, not in this one.** A new
D-Bus method on an older daemon fails as an unknown method, which the window cannot explain; a bump
puts it on the existing `DaemonWireMismatchError` path ("one side must restart",
`daemon-bus.ts:87`) instead of a raw bus error.

### 6. Pin limits: a local favourite is never evicted, and never evicts

A star beyond the protocol's pin limit stays a favourite in curlew and is **not** pushed. The
person is told once, where they starred it ("Telegram pins are full — starred in curlew only"), and
it is not retried silently. Curlew never unpins something else to make room: that changes state on
their phone for a reason they did not give. Which chats hold the pin slots is therefore
first-come — to move one, the person unstars the other.

Favourites is a **view** on the conversation list, like Unread, not a folder: it shows every
favourite whether it got a pin slot or not, so the limit never hides a chat.

### 7. Mentions notify despite mute

The mute check belongs in `message-notices.ts` (which messages deserve a notification), not in the
transport. A muted conversation produces no notice — **unless** the message's mentions name one of
the account's own ids, which schema v28 already stores (`mentions_json`,
`packages/store/src/schema.ts:511`). Then it notifies normally. The daemon knows the account's own
protocol ids, so the pure notice function takes them as an argument.

Counting: a muted chat keeps its unread count in the list (dimmed, with a bell-off icon and an
accessible label) and appears in the Unread group ([#483](https://github.com/JumpLink/curlew/issues/483) —
that group is a view of what is unread, not of what deserves attention), but it is **excluded from
the shell badge**, which exists to pull the person in.

### 8. Merged contacts: per thread, asymmetric roll-up

Both flags are stored per thread (one conversation on one backend), per the owner's decision. What
the merged contact shows differs by flag, because the promises differ:

- **Muted** when **every** thread is muted. Mute is a promise of silence; one unmuted network
  breaks it. Otherwise the contact is unmuted and states where it is muted ("muted on Telegram").
  Muting from the contact page mutes every thread, each in its own network, each reported.
- **Favourite** when **any** thread is starred. A star is a preference, not a promise, and this is
  what makes it survive a merge, a split and a change of default chat protocol, which is
  [#484](https://github.com/JumpLink/curlew/issues/484)'s actual requirement. Starring from the
  contact page sets it on every thread; unstarring clears all of them.

### 9. Capabilities per thread (ADR 0015)

`BackendCapabilities` gets two optional upper-bound flags, `mutes` and `pins`, and the per-thread
narrowing answers them for one thread (a Telegram channel, a Matrix room, the person's own notes).
They do **not** join `ThreadCapabilities`' action list: unlike a reaction, the mute and star action
is always offered, because the local form always exists. What the capability decides is only the
label and whether a write is attempted — the one case where ADR 0015 §2's "no action that fails
later" is satisfied by an action that does less, visibly, rather than by hiding it.

An agent gets no mute or star tool: these are the person's settings, and ADR 0008 keeps grants out
of the person's way, not the other way round. MCP may **read** the flags (a flag is not content).

### 10. Out of scope

Archive (Telegram's archived folder is already read, `packages/telegram/src/api.ts:124`) and chat
locks ([#523](https://github.com/JumpLink/curlew/issues/523)). Also: an account-wide "mute all
groups" setting, per-chat notification sound or priority, Matrix keyword push rules, Signal's
storage service, and XMPP bookmarks as a favourite store. A bulk mute in the UI needs no decision —
it is the same per-thread write, several times.

## Consequences

- `@curlew/store` gains schema v30 and a flags module; every reader of the conversation list joins
  it, and the daemon's notice path reads it per conversation.
- Three backends gain a read field they currently drop (`TgDialog`, `MxRoom`, `WaChat`) and a write
  method; Telegram and Matrix write without touching their gate shape, WhatsApp widens its granted
  handle under ADR 0004.
- One new daemon method and one wire bump, when that method lands.
- Signal, XMPP and mail offer the features locally, and say so. Nothing is silently local.
- Tests: an echo does not flip the local flag; a remote change with nothing pending wins; a pending
  write survives one contradicting sync and loses the second; a muted chat yields no notice but a
  mention in it does; a favourite beyond the pin limit stays a favourite and pushes nothing; a
  merged contact with one unmuted thread reads as unmuted and with one starred thread as a
  favourite; `ui.syncChatFlags: false` pushes nothing and withdraws nothing.
