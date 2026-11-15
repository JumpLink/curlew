# ADR 0017 — online status and last seen are ephemeral, per thread, and offered only where the protocol has them

- **Status:** Proposed (2026-11-15). Needs Pascal's approval; no code yet.
- **Scope:** `@curlew/protocol` (a presence port and a capability flag), the backends that can answer
  it (`@curlew/xmpp`, `@curlew/matrix`, `@curlew/telegram`, `@curlew/whatsapp`), `app` (daemon,
  session-bus signal, window subtitle, a setting), `docs/privacy/`.
- **Builds on:** [ADR 0001](0001-multi-protocol-messenger.md) (backends behind one port),
  [ADR 0002](0002-receiving-daemon.md) (the daemon receives),
  [ADR 0007](0007-live-updates-over-the-session-bus.md) (journal in the index, wake-up on the bus),
  [ADR 0015](0015-capabilities-per-thread.md) (capabilities per thread).

## Context

A chat header that says "online" or "last seen today 14:02" is a feature people expect from a
messenger, and one that can quietly hurt: presence flows **both ways**, and a client that only wants
to *read* it can end up *announcing* it. The code already knows this. Every backend is configured to
stay quiet today:

| Backend | What the daemon announces today | Where |
|---|---|---|
| Matrix | nothing: `disablePresence: true`, and the read-only guard refuses a `/sync` without `set_presence=offline` | `packages/matrix/src/client.ts:462-464`, `packages/matrix/src/guard.ts:54-55` |
| WhatsApp | `unavailable`: `markOnlineOnConnect: false`, so Baileys sends `sendPresenceUpdate('unavailable')` on open | `packages/whatsapp/src/client.ts:134`, `baileys/lib/Socket/chats.js:1065` |
| XMPP | **available**, priority −1, once follow mode starts: `followPresence()` is `<presence><priority>-1</priority></presence>` | `packages/xmpp/src/stanza.ts:545`, `packages/xmpp/src/client.ts:372` |
| Telegram | MTProto has no "connected" flag; a user's `online` status follows API activity. Whether our account looks online is a side effect of what the client calls. Not verified here. | `@mtcute/core` `User.status` |
| Signal, mail, Delta Chat | no presence concept | — |

So XMPP is the one backend where the daemon already tells contacts something about us, and nobody
has chosen that.

### What each protocol offers (from the libraries in `node_modules`)

- **XMPP.** Presence stanzas (`show`, `status`, `priority`) arrive only from contacts whose
  presence we are **subscribed** to (RFC 6121: `subscription` is `to` or `both` in the roster). No
  subscription, no presence. Last activity is XEP-0012 (`jabber:iq:last`), answered by the server for
  an offline bare JID only if it allows it, usually only to subscribers. XEP-0319 (`urn:xmpp:idle:1`)
  adds `<idle since="…"/>` to a presence. Neither XEP is implemented in `packages/xmpp` today
  (`@xmpp/*` ship the stanza codec, not these extensions); `XmppApi.features(jid)`
  (`packages/xmpp/src/client.ts:420`) can tell whether a contact's client advertises them.
- **Matrix (matrix-js-sdk).** `m.presence` events arrive in `/sync` and fill `User.presence`
  (`online`/`unavailable`/`offline`), `User.presenceStatusMsg`, `User.lastActiveAgo` (ms before
  `lastPresenceTs`) and `User.currentlyActive` (`matrix-js-sdk/lib/models/user.d.ts:96-127`); events
  `User.presence`, `User.currentlyActive`, `User.lastPresenceTs`. `client.getPresence(userId)` and
  `client.setPresence()` (`client.d.ts:1921-1927`) ask and set explicitly. Many homeservers turn
  presence off (Synapse `presence.enabled: false`; matrix.org does) and then every user is
  `offline` or the event never arrives. "No data" must differ from "offline".
- **Telegram (mtcute).** `User.status`: `online | offline | recently | within_week | within_month |
  long_time_ago | bot` (`@mtcute/core/highlevel/types/peers/user.d.ts:17`). `lastOnline` exists only
  for `offline`, `nextOffline` only for `online`. The coarse buckets are the **privacy setting of the
  other person** (or ours: `statusHiddenByMe` says the user's status is hidden *because we hid ours*,
  Telegram's reciprocity). `UserStatusUpdate` is the live update (`updates/user-status-update.d.ts`).
- **WhatsApp (Baileys).** `presenceSubscribe(jid)` (`chats.js:645`) asks for a contact's presence;
  results arrive as `presence.update` with `PresenceData { lastKnownPresence, lastSeen?,
  groupOnlineCount? }` (`Types/Chat.d.ts:20-24`, `Types/Events.d.ts:49-53`). `lastSeen` is absent
  when the contact hides it (`attrs.last === 'deny'`, `chats.js:673`). Subscribing is itself a
  request the other side's client may see, and **announcing `available` ourselves**
  (`sendPresenceUpdate('available')`, `markOnlineOnConnect: true`) makes WhatsApp treat curlew as the
  foreground device: the **phone stops showing push notifications** for that account while we are
  "online", and contacts see us online. That is exactly why `markOnlineOnConnect: false` is set.
- **Signal.** No presence, no last seen. Typing indicators only.
- **Mail / Delta Chat.** No presence. Delta Chat's "last seen" is **derived**: the date of the newest
  message received from that contact. Curlew can compute the same from its own index, per peer, with
  no protocol traffic.

## Decision

### 1. Presence is ephemeral state, not index data

Online status is stale in seconds and means nothing after a restart. It does **not** go in the index
(no table, no `index_changes` row; ADR 0007's journal records durable writes). The daemon holds it in
memory per account and contact and exposes it on the session bus, per ADR 0007's split "the daemon
describes nothing about content":

- a method `GetPresence(account_id, address) → (state, since)` for a reader that starts late;
- a signal `PresenceChanged(account_id, address)` carrying **no state**, so bus traffic stays free of
  names' activity beyond what a conversation id already is; the window then calls `GetPresence`.

`state` is one of `online`, `idle` (with `since`), `offline` (with optional `last_seen`),
`recently` / `within_week` / `within_month` (Telegram buckets, never refined), `unknown`
(no data, hidden, or the server disabled presence).

The one **durable** exception is Delta Chat/mail, which needs no feed: "last seen" is the newest
received `date` per peer, computed by the existing conversation query. It also serves as the fallback
for every chat protocol when the live feed is `unknown`, labelled "last message", never "last seen".

### 2. The window shows it under the chat title

- Subtitle under the thread title: `online`; `idle since 14:02` (XMPP idle, Matrix `unavailable`);
  `last seen today 14:02` / `yesterday` / `<date>`; Telegram buckets as `last seen recently` and so
  on; nothing at all for `unknown`.
- A small dot on the list avatar only for `online`. Not for `idle` or `offline`: a list of grey dots
  is noise.
- A **merged contact** shows the **newest** signal across its protocols; `online` on any wins. The
  label does not name the protocol (the chat does). Deriving it is `max()` over the threads' states.
- Time formats go through gettext and the existing relative-date helper; the strings are new
  msgids with German catalogue entries per [`docs/i18n-status.md`](../i18n-status.md).

### 3. Capability flag, offered only where the protocol has it

A per-thread capability `presence: 'none' | 'coarse' | 'exact'` joins ADR 0015's set (manifest value
is the upper bound; per-thread narrows it):

| Backend | Manifest (upper bound) | Per-thread narrowing |
|---|---|---|
| XMPP | `exact` | `none` unless roster subscription is `to`/`both`; `exact` also needs XEP-0012 or 0319 for "last seen" |
| Matrix | `exact` | `none` when the homeserver sends no `m.presence` for the user |
| Telegram | `coarse` | `exact` when the other side shows `lastOnline`; the bucket otherwise |
| WhatsApp | `exact` | `none` when `lastSeen` is denied and no `available`/`unavailable` arrives |
| Signal, mail, Delta Chat | `none` | — (Delta Chat: the derived "last message" only) |

If the thread's flag is `none`, the subtitle is absent. No placeholder, no greyed-out entry (ADR 0015
§2).

### 4. Our own visibility: a setting, default off

A single setting **"Show me as online"**, per account, **default off**, stored in the app settings
like the other per-account switches. Off means: curlew **receives presence but announces none**.

| Backend | Off | On |
|---|---|---|
| Matrix | `set_presence=offline` (as today) | `online` while the window is focused, `unavailable` when idle |
| WhatsApp | `unavailable` (as today); live presence of contacts still requires `presenceSubscribe` | `available` while the window is focused only, never from the daemon alone (phone notifications) |
| XMPP | **changes today's behaviour:** follow mode stops sending the broadcast `followPresence()`. It sends presence **directed only to nobody**, or an `unavailable`-equivalent, and still receives (see open question 1) | available; `idle` via XEP-0319 once the window is unfocused |
| Telegram | no explicit switch in the protocol layer; follow the account's own privacy setting and don't call "online" APIs we don't need (open question 2) | — |

**Reciprocity.** WhatsApp and Telegram already tie *seeing* to *showing*: hide your own last seen
and you lose theirs. Curlew does not paper over it. With the setting off, the UI says so once
("Others' last seen needs you to show yours on WhatsApp"), and `unknown` is what the person sees.
Same rule as read receipts: no silent switch that makes the app say more about the person than the
person decided.

**Daemon vs window.** Our own presence is announced only by the **focused window**, never by the
daemon: the daemon runs 24/7 and "always online" is both false and the cause of the WhatsApp
notification loss. The daemon still subscribes and receives, which is passive on Matrix, XMPP
(already subscribed) and Telegram; on WhatsApp it needs `presenceSubscribe` per open or listed
thread, bounded (§5).

### 5. Cost on the phone and the network

- **Matrix:** `m.presence` rides the existing `/sync`; it can double the event volume on a large
  homeserver. No extra request. (If `getPresence` is used, one request per thread open, cached 60 s.)
- **XMPP:** presence stanzas arrive for every subscribed contact whether we show them or not. A
  few bytes each; no extra connection. Roster size caps the churn.
- **Telegram:** `UserStatusUpdate` only for contacts the server pushes; no polling, no battery cost
  on the phone. Fetching the status of non-contacts costs a `users.getUsers` call: only for the open
  thread.
- **WhatsApp:** one `presenceSubscribe` per contact, only for the **open thread and the visible head
  of the list** (not the whole contact list), re-subscribed on reconnect. Each subscription is an
  outgoing request; an unbounded list looks like scraping and risks the ban the registry's terms
  notice already warns of. Ours being `unavailable` keeps the phone's notifications.
- **Signal, mail:** zero.

The daemon refreshes presence only while a window is open (`curlew window` registers on the bus);
with no window, it keeps nothing but the live feed it gets anyway. That puts a ceiling on network
and battery cost on the phone: no polling loop, ever.

### 6. Privacy

- Presence never leaves the machine except as the window sets it; it is not written to logs
  (ADR 0002 §6), the index, MCP output, or the CLI. Grants do not extend to it: an agent gets no
  presence tool (ADR 0008 keeps agents out of what the person's frontends see).
- No history. "Last seen" is the latest value the server gave, replaced on the next one. Nothing is
  accumulated into an activity pattern.
- The privacy notes (`docs/privacy/{matrix,whatsapp}.md`) gain a "presence" paragraph naming exactly
  the table in §4.

## Consequences

- Protocol gains `Presence` DTO, `PresenceCapability`, and a backend method `watchPresence()` that
  every backend may leave unimplemented (manifest default `none`).
- XMPP's `followPresence()` becomes conditional: the setting default (off) changes today's behaviour
  for existing users. That is a deliberate fix of an unchosen leak, announced in the changelog.
- The conversation list needs one more column in its view-model (the dot); it must not trigger a list
  rebuild on every presence change (coalesce to ≥ 5 s).
- Tests: a thread with capability `none` has no subtitle; a merged contact shows the newest of two
  states; XMPP without a subscription yields `unknown`; WhatsApp `lastSeen` denied yields no time;
  the setting off sends no presence on any backend (the existing Matrix guard and WhatsApp
  `markOnlineOnConnect` stay as canaries, XMPP gets one).

## Open questions for Pascal

1. **XMPP default.** Should follow mode keep announcing `available` (−1 priority) as today, or go
   silent by default? A silent mode needs the account's presence to be `unavailable` with carbons
   still on, which not every server delivers to (ADR 0004 §5 notes carbons need an available
   resource). Silent may break live receipt; if so, XMPP stays visible and the setting only adds
   `idle`.
2. **Telegram.** Do we want an explicit "last seen visible to…" control, or leave that wholly to
   Telegram's own privacy setting? Calling mtcute's `account.updateStatus` is the only way to flip
   `online`; verify what the daemon's current calls already do before deciding.
3. **Matrix with presence disabled** (most servers): show "last message" derived from the index, or
   show nothing?
4. **Dot on the list** for `online`: yes or leave the list quiet?
5. **WhatsApp subscribing** to the visible head of the list: acceptable under the terms notice, or
   only the open thread?
6. **Delta Chat "last seen"**: show it for mail contacts too (derived from the newest message), under
   the label "last message"?
