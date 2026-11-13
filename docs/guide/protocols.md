# Protocols in detail

Per-protocol setup, terms and behaviour. The overview table is in the [README](../../README.md#protocols).

## Telegram

Telegram requires every third-party client to use an `api_id` and `api_hash`.
They identify the *application*, not you. The repository and CI/dev builds ship
none; a **packaged build may embed one pair** that its distributor supplied at
build time (see [Packaging](releasing.md#embedding-a-telegram-api-pair-packagers)), so the
login asks for phone number and code only. Which pair is used, first match wins:

1. `CURLEW_TELEGRAM_API_ID` / `CURLEW_TELEGRAM_API_HASH` in the environment;
2. the pair stored in the account's session file (what it was created with);
3. the pair embedded in this build, if any;
4. otherwise the login asks for one (steps below).

To use credentials of your own even when the build embeds a pair (so you do not
depend on a package id Telegram might block), create an app for yourself at
<https://my.telegram.org> → *API development tools* (an `api_id`, a number, and
an `api_hash`, 32 hex characters) and log in with `--own-credentials`:

```bash
curlew backends enable telegram --accept-terms   # shows Telegram's terms once
curlew accounts add telegram                     # phone, code, 2FA password; asks for api_id/api_hash first if the build embeds none
curlew accounts add telegram --own-credentials   # always asks for your own api_id/api_hash (hash without echo)
curlew accounts list --backend telegram
curlew sync                      # mail and Telegram into one index
curlew conversations list --people-only
```

The pair is kept in the account's session file, not in the config (which is
plain text in every backup; a config that carries one is refused), together with
whether it was the embedded or your own. A session created with the embedded
pair never switches silently: if a later build embeds a different pair (or none),
`sync` fails with a message saying so — use the original build, set the
environment variables, or log in again. Telegram has no public test credentials
that curlew may use; accounts that use them get banned, so none is a default.

The first sync takes the newest 200 messages of every chat; later syncs walk
forward from there, at most 5 000 messages per run (the rest follows on the
next). A contact whose phone number is in your address book becomes the same
person as their mail address. Channels and bots are classified *automated*.

A message deleted on Telegram stays in the index until a full scan:
`curlew sync --full-scan` re-reads each chat's newest window and removes every
stored message in it that Telegram no longer has, and every chat that left your
list. (Telegram reports deletions only as live updates, which a sync without a
daemon does not receive.) Below that window each full scan additionally asks
Telegram about 200 stored messages per chat, oldest first, and continues where
the last scan stopped — so a deletion deep in a long chat is found within a few
full scans rather than never.

The login leaves a **session file** at
`$XDG_DATA_HOME/curlew/secrets/telegram/telegram-<user id>.db` (mode `0600`
in a `0700` directory; override the base with `CURLEW_SECRETS_DIR`). Whoever
holds it can read your Telegram account (it also holds your `api_id`/`api_hash`):
back it up like a password, never share it. A login killed halfway leaves a
`login-*.pending.db` there; the next `accounts add` or account listing removes it
once it is 15 minutes old. Telegram lists it under *Settings → Devices* as `curlew`, where you can
end it; deleting the file ends it on this machine.

## WhatsApp

> **Read this first.** WhatsApp has no API for reading your own chats. Curlew
> uses [Baileys](https://github.com/WhiskeySockets/Baileys), an **unofficial**
> reimplementation of the WhatsApp Web protocol. Using it **violates WhatsApp's
> Terms of Service**, and WhatsApp bans accounts it sees using unofficial
> clients — temporarily or for good. The ban hits your **phone number**. Enable
> this only if you accept that risk for that number.

Curlew joins your WhatsApp as a **linked device**, like WhatsApp Web:

```bash
curlew backends enable whatsapp --accept-terms   # shows the notice above once
curlew accounts add whatsapp                     # QR code, or a pairing code
curlew sync                                      # right away — see below
curlew conversations list --people-only
```

`accounts add whatsapp` asks for a phone number. Leave it empty and a QR code
appears in the terminal: on the phone, *WhatsApp → Settings → Linked devices →
Link a device*, and scan it (a new code appears every ~20 s). Or type the number
(international, `+49…`) and enter the 8-character pairing code it prints under
*Link a device → Link with phone number instead*. The device shows up in that
list as a browser session (Baileys' default, *Chrome (Mac OS)*); unlink it there
to end it.

**WhatsApp keeps no archive.** A message is gone from WhatsApp's servers once a
device has received it, so what curlew stores is the **only copy** it has —
its part of the index is irreplaceable, not a cache. Consequences:

- **Run `curlew sync` right after linking.** The phone hands the recent
  history (roughly the last months) to a new device once. `sync` connects,
  receives that history and everything queued while no device of curlew was
  connected, writes it, and disconnects once WhatsApp has nothing more to hand
  over. If that does not happen within ten minutes, the run stops there and that
  is **not an error**: everything received is written and the run counts as a
  success. The only sign in the output is that account's `caughtUp: false`
  (`error` stays `null`), and whatever WhatsApp still had queued arrives in the
  next `sync`. Set `backends.whatsapp.settings.fullHistory: true` in the config
  **before** linking to ask for the full history instead — larger, slower.
- **Stay connected — the [receiving daemon](daemon.md).** WhatsApp unlinks
  a device that has not connected for about 14 days; after that, `sync` reports
  the logout and you link again (the conversations stay, under the same account
  id). `curlew daemon` holds the connection, so that clock never runs out; a
  `sync` from a timer is the fallback for a machine where the daemon does not
  run.
- **Back up the index** (`$XDG_DATA_HOME/curlew/index.db`) like the config:
  with WhatsApp enabled it holds messages that exist nowhere else.

Deletions and edits are applied as they arrive: a message the sender deleted
for everyone, or you deleted or cleared on your phone, is removed from the index;
an edited one gets the new text. Contacts are linked by phone number to your
address book, like Telegram's.

What curlew sends: nothing you could see. It connects with
`markOnlineOnConnect: false`, so it announces itself *unavailable* (never online)
and your phone keeps its notifications; it never sends a read receipt (the
blue ticks stay yours). It does acknowledge each delivered message — the grey
double tick every linked device sends, and the signal for WhatsApp to forget the
message.

The link leaves a **session file** at
`$XDG_DATA_HOME/curlew/secrets/whatsapp/whatsapp-<LID>.db` (mode `0600`): the
device's Signal keys. Whoever holds it can read your incoming WhatsApp messages —
back it up like a password, never share it. The account id is your LID,
WhatsApp's privacy id, never your phone number.

## Signal

> **Read this first.** Signal offers no API and does not license third-party
> clients. Curlew is **not an official Signal client** and Signal does not
> support it. It uses libsignal, Signal's own library, and links like Signal
> Desktop. Independent clients of this kind (signal-cli, Flare, Whisperfish) are
> used without known account bans, but Signal could block them at any time.

Curlew joins your Signal account as a **linked device**, like Signal Desktop:

```bash
curlew backends enable signal --accept-terms   # shows the notice above once
curlew accounts add signal                     # prints a QR code
curlew sync                                    # right away — see below
curlew conversations list --people-only
```

Linking, step by step:

1. Run `curlew accounts add signal`. A QR code appears in the terminal.
2. On the phone: *Signal → Settings → Linked devices → Link new device* (the `+`),
   and scan the code. If the terminal prints a fresh code, scan that one: Signal
   replaces the connection behind a code after a while.
3. The phone asks you to confirm linking a device named `curlew` (set
   `backends.signal.settings.deviceName` in the config to change it). Confirm.
4. The terminal says *Linked*. The phone now lists `curlew` under *Linked
   devices*; unlink it there to end it.
5. Run `curlew sync`.

Signal runs on **linux-x64 and macOS arm64** (libsignal is a native addon that
curlew loads through gjsify's N-API host). On another platform the rest of
curlew works; `accounts add signal` says libsignal did not load.

**Signal keeps no archive.** The server holds a message for a device only until
that device receives it, so what curlew stores is the **only copy** — its part
of the index is irreplaceable, not a cache. Consequences:

- **Curlew gets no history.** A linked device receives what arrives after it
  was linked; the phone's older messages stay on the phone.
- **Stay connected — the [receiving daemon](daemon.md).** `sync`
  connects, receives what was queued, writes it and disconnects once Signal
  reports the queue empty. If the queue does not go
  empty within ten minutes, the run stops there and that is **not an error**:
  everything received is written and the run counts as a success. The only sign
  in the output is that account's `caughtUp: false` (`error` stays `null`), and
  whatever is still queued arrives in the next `sync`. Signal unlinks a device
  that stays offline too long; after that, `sync` reports it and you link again
  (the conversations stay, under the same account id), and `curlew daemon`
  holds the connection so it does not come to that.
- **Back up the index** (`$XDG_DATA_HOME/curlew/index.db`) like the config.

What arrives: direct and group messages (sealed sender included), your own
messages sent from the phone, edits, deletions (for everyone, and the ones you
make on the phone), read receipts for your messages, and the contact list when
the phone sends it (it does after linking and when contacts change; the
download needs Node for now, see below). A group takes its name the next time a
message arrives in it: Signal keeps group names encrypted on its group server,
so curlew reads that one name (two read-only requests, to Signal's chat service
and to `storage.signal.org`, for groups you already belong to) and keeps it in
the session file. Set `backends.signal.settings.groupNames` to `false` to never
ask; groups then stay *Unnamed group*. Reading a chat on the phone is not mirrored: messages arrive unread.
Reactions, typing, calls and a disappearing-messages timer are read and dropped
on purpose; they are settings, not messages.

Two things curlew reports instead of swallowing:

- A **changed safety number** shows up in that contact's conversation as a
  *Safety number changed* notice — already read, never unread. Compare the
  number on the phone before you trust the conversation.
- A message curlew decrypted but **could not read** (a message type a newer
  Signal added, or a bug in the decoder) is **not** thrown away: the raw
  plaintext goes into the session file, and `sync` reports how many. Nothing is
  lost on Signal's side either — curlew only acknowledges an envelope once
  that plaintext is on disk. `curlew deliveries set-aside` lists them: who
  sent it, when, why curlew could not map it and how big the plaintext was —
  enough to look the message up on the phone or to report a decoder bug. The
  plaintext itself is never printed, and no flag prints it.

What curlew sends: at link time, two requests — it registers the device with
the one-time code the phone sent, and publishes one batch of pre-keys so
contacts can start encrypted sessions with it. During `sync`, only the
acknowledgement of each received message (without it Signal would deliver it
again), and only after the message is written to disk. Never a message, a read
or delivery receipt, a typing notice, a request to the phone, or a retry request
for a message it could not decrypt — `sync` counts those and reports them.

The link leaves a **session file** at
`$XDG_DATA_HOME/curlew/secrets/signal/signal-<ACI>.db` (mode `0600`): your
account's identity key and this device's keys. Whoever holds it can read your
incoming Signal messages — back it up like a password, never share it. The
account id carries your ACI (Signal's account UUID), never your phone number.

Known gap: the contact list is downloaded from Signal's CDN, which needs Signal's
own root certificate; on GJS, gjsify's `node:https` does not take one yet, so
`sync` reports the contact list as not read and people appear by their Signal id
until the next contact sync after that is fixed.

## XMPP

Curlew reads XMPP history only from the server's **message archive** (MAM,
XEP-0313), which Prosody (`mod_mam`, `mod_muc_mam`) and ejabberd offer. A server
without one is refused with an explanation: the alternative, receiving offline
messages, would take them away from your other clients.

```bash
curlew backends enable xmpp
curlew accounts add xmpp        # JID, password (no echo), server address
curlew sync
```

The server address may stay empty: Curlew then looks up direct TLS
(`_xmpps-client._tcp` SRV, XEP-0368), then WebSocket (`host-meta`, XEP-0156),
then STARTTLS. The certificate is checked against your XMPP domain. All three
endpoint kinds work on GJS as of the gjsify release Curlew runs on (0.54.0):
the raw TLS socket landed in [gjsify#1837](https://github.com/gjsify/gjsify/pull/1837)
and the last piece, `Readable.prototype.addListener` aliased to `on`, in
[gjsify#1958](https://github.com/gjsify/gjsify/pull/1958) — without it @xmpp/tls
subscribed to the peer's bytes through `addListener` and the stream sat at
"opening" until the login timed out.
A server with its own CA: set `backends.xmpp.settings.tlsCaFile` to the PEM file.
A publicly-trusted certificate is checked reliably; a custom one is checked
unreliably on GJS, because gjsify decides it in a JS `accept-certificate`
callback that GIO emits on its handshake thread and GJS blocks. Measured 1 of 20
logins refused with a certificate error on 0.54.0 (2 of 12 before), so a
custom-CA server may need a second attempt there.

The login uses SCRAM-SHA-1 and sends a password in the clear (PLAIN) only inside
TLS. The password is kept in
`$XDG_DATA_HOME/curlew/secrets/xmpp/xmpp-<hash>.db` (`0600`), never in the
config — a config that carries one is refused.

Chats are your roster contacts and the bookmarked rooms you join automatically.
Corrections (XEP-0308) replace the stored text, retractions (XEP-0424/0425)
remove the message. OMEMO-encrypted messages are read and written for every enabled
account; no grant is involved. See [End-to-end encryption](#end-to-end-encryption) and
[ADR 0006](../adr/0006-omemo-end-to-end-encryption.md).

### Sending (grants `<backend>.send`)

Grants are **agent access** (ADR 0008): the CLI and the MCP tool — the frontends an
agent drives — send one message only from an account and to an address you
granted, as an exact `<account>/<address>` pair (see
[Your data stays yours](mcp-and-data.md#your-data-stays-yours)); a message to the account's own
address needs no grant. Your own frontends — the daemon's send service today, the
UI later — send from every enabled account without one. Every send, whoever made
it, leaves a line in the write log. Every backend has its own
capability — `xmpp.send`, `mail.send`, `telegram.send`, `matrix.send`, `signal.send` and
`whatsapp.send` today — and one grant never authorises
another backend:

```json
{ "grants": [ { "capability": "xmpp.send", "target": "xmpp-abc123/owner@example.org" } ] }
```

The limit, stated plainly: under one Unix user an agent with a shell can still call
the daemon's D-Bus `Send` directly, and no grant stops that. A hard boundary needs
a sandbox, which is future work.

```bash
curlew send --account xmpp-abc123 --to owner@example.org "Build is green"
```

#### XMPP

An image goes with `--image-url https://…` (text optional). The URL is sent as
its own message after the text: body = the URL plus an out-of-band reference
(XEP-0066, `<x xmlns='jabber:x:oob'><url>…</url></x>`), the shape Conversations,
Gajim and Monocles render inline. Text and image are two stanzas, because a
client shows the file only when the body is exactly the URL. https only, no
credentials in the URL; curlew neither uploads nor fetches the image, and the
same `xmpp.send` grant covers it.

The MCP server offers the same as `send_message` (`account`, `to`, `text`,
`image_url`; at least one of the last two) —
always listed. Without a grant it can only send to your own account (your own
address, note to self); anything else needs the exact `<backend>.send` grant
for the account and address, so a `mail.send` grant does not let an agent write
over XMPP. For XMPP the answer carries `conversationId`, `sentAt` and `originId`.
`send_message` also takes `format`: `plain` (default, the text goes out as is) or
`markdown`. Markdown is rendered as XEP-0393 message styling (other protocols would get
a plain-text degradation), an image link on its own line becomes an image message, and a
text over 7000 characters is split at line breaks into several messages instead of being
refused. A markdown answer adds `parts` (how many messages went out) and `originIds`
(every id, in order; `originId` is the first). The read-only tool `messaging_capabilities`
reports per protocol the maximum message length, the formats, image support, the longest
`timeout_s` and whether long texts are split — no addresses, no account data.
The message goes out as `type=chat` with an origin-id (XEP-0359), a receipt
request (XEP-0184) and `markable`; it is stored in the index as your own
message, and the archive's copy replaces that local echo on the next sync.
Every send is logged (time, grant, target, never the text) to
`$XDG_DATA_HOME/curlew/writes.log`.

#### Mail

`mail.send` sends one plain-text mail with an optional `--subject` (or
`subject` in `send_message`) and optional file attachments. The recipient is the granted address and the
sender is the account's own address; the SMTP credentials come from the
account (Curlew's own or GNOME Online Accounts) and appear in no output, log or error. There is
no HTML, and a sent mail is not indexed as a conversation —
the answer has `sentAt` and the message id, no `conversationId`:

```bash
curlew send --account <goa-account-id> --to owner@example.org \
  --subject "Build is green" "All tests passed."
```

Attachments: repeat `--attach <absolute path>` on the CLI, or pass
`attachments: ["/abs/path/report.pdf"]` to `send_message`. Only mail carries them; every
other backend refuses, as does the daemon's bus send. Rules: absolute paths, regular
files only (a symlink is followed once and its target must be a regular file), at most 10
files, 20 MB each and 25 MB together. The attachment name is the file's base name and the type
comes from the extension (otherwise `application/octet-stream`). They ride on the address
grant ([ADR 0004](../adr/0004-sending-and-writing-granted-per-capability.md)); the
permission prompt lists the file names, and the write log records names and sizes, never
content.

```bash
curlew send --account <goa-account-id> --to owner@example.org \
  --subject "Report" --attach /home/me/report.pdf "Attached."
```

#### Telegram

`telegram.send` sends one plain-text message to a chat. The address is the chat id
exactly as `curlew conversations list` shows it: the user id for a direct chat, the
negative id for a group or channel, so a grant reads
`{ "capability": "telegram.send", "target": "telegram-42/1001" }`. A text over 4096
characters is refused rather than split, and there is no Markdown and no image. The
sent message is stored in the index as your own message and replaced by Telegram's
copy on the next sync. Telegram only resolves a chat the account has already synced,
so run `curlew sync` once before the first send to a new chat:

```bash
curlew send --account telegram-42 --to 1001 "Build is green"
```

#### Matrix

`matrix.send` sends one plain-text `m.room.message` to a room. The address is the room
id exactly as `curlew conversations list` shows it, colon and all, so a grant reads
`{ "capability": "matrix.send", "target": "matrix-0123456789abcd/!room:example.org" }`.
A body over 32000 UTF-8 bytes is refused rather than split, and there is no Markdown
and no image. The sent message is stored in the index as your own message and replaced
by the homeserver's copy on the next sync.

**An end-to-end encrypted room is refused.** Curlew reads encrypted rooms — it decrypts
what it holds the key for — but it does not encrypt, so it will not put a cleartext
message into a room whose members chose encryption. Before every send it reads the
room's `m.room.encryption` state; if the homeserver cannot answer, the send is refused
too, never attempted in the dark:

```bash
curlew send --account matrix-0123456789abcd --to '!room:example.org' "Build is green"
```

#### WhatsApp

`whatsapp.send` sends one plain-text message to a 1:1 chat. The address is the chat id
exactly as `curlew conversations list` shows it — a full JID, `<digits>@lid` or
`<digits>@s.whatsapp.net` — so a grant reads
`{ "capability": "whatsapp.send", "target": "whatsapp-2084.../1348...@lid" }`. A bare phone
number is refused, and so is a `<user>:3@…` device address: both leave open which chat is
meant, and the grant has to name the string you read back. A text over 65536 UTF-8 bytes is
refused rather than split, and there is no Markdown and no reaction. Files go along as `--attach`
(up to 10, 64 MB each): one message per file, pictures and MP4 videos as such, everything else as
a document under its file name, and a text up to 1024 characters becomes the caption of the
first. An agent is always asked before it sends files. Groups and
status updates are refused — a group message needs a member list curlew does not keep. The
sent message is stored in the index as your own message and replaced by WhatsApp's own copy
when it comes back.

**A send needs the daemon to let go of the account.** WhatsApp allows one connection per
linked device, and the session state is a single file both would write, so curlew takes the
same lease the daemon takes and refuses the send while the daemon holds it, naming
`curlew daemon stop` as the way out. A refusal is the safe outcome here: a race on that file
can end in a logout, and relinking would lose the history WhatsApp never hands out twice:

```bash
curlew send --account whatsapp-208451726394015 --to '134875029461837@lid' "Build is green"
```

**Waiting for a reply.** Run `curlew daemon`: for every enabled XMPP account it
stays connected, enables carbons (XEP-0280) and catches up from the archive on
every arrival and after every reconnect, so a reply reaches the index within
seconds. Then call the read-only MCP tool
`xmpp_wait_reply {account, peer, after, timeout_s}` with the `sentAt` of the
send as `after`: it returns `{status: "reply", messages, cursor}` or
`{status: "timeout", cursor}`; pass `cursor` as `after` of the next call.
Each reply message has `replyToId`, the id its XEP-0461 `<reply>` names (null
when it is not a reply). `send_message` returns `originId` — the message's
stanza `id`, identical to its origin-id (XEP-0359) — so compare the two to see
which sent message was answered.
With `strip_quotes: true` the quoted lines (`> …`) a client adds to a reply are removed
from each message's text; the default is `false`, and a message that is only a quote is kept.
`conversations_get {id, since, incoming_only}` is the non-blocking form. The
cursor compares the sender's timestamp with the one you stored, so a badly
skewed clock can hide or repeat a message.

Limits, stated plainly: there is no stream management (XEP-0198): a message
written as the connection drops is not retransmitted (receiving is covered by
the archive catch-up). Rooms are not joined; they are only read through the
archive on connect and `curlew sync`. Encryption is
one-to-one only — a room is never encrypted.

### End-to-end encryption

OMEMO (XEP-0384, the `eu.siacs.conversations.axolotl` version every current
client speaks) is on for every enabled XMPP account; there is no grant for it.
What an agent may read of the decrypted text is decided per account and contact
by `agentAccess`. An old `xmpp.omemo` grant in the config is ignored.

Curlew becomes a device of that account: it publishes an identity key
and a bundle, decrypts incoming messages into the index, and encrypts what you
send to every trusted device of the peer and to your own other devices. Keys
live in the account's secret file (`0600`), next to the password, and never in
the config or the index.

Trust is blind trust before verification, as Conversations does it: a key first
seen on a contact is accepted and from then on fixed. `curlew omemo devices
--account xmpp-abc123` lists the fingerprints; the MCP tool `omemo_devices`
shows the same, read-only. **No MCP tool changes trust, and no agent can turn
encryption off.**

A peer who has OMEMO devices is never sent plaintext. If their key material
cannot be fetched, or no device of theirs is trusted, the send is **refused**
with the reason — it does not quietly go out in the clear. A peer with no OMEMO
at all still gets plaintext, as before.

Verifying a fingerprint by hand, resetting a broken session and the
"encryption required" setting are not there yet
([ADR 0006](../adr/0006-omemo-end-to-end-encryption.md) stage 4).

## Matrix

Matrix is an open protocol, so there are no terms beyond your homeserver's own.
Log in with your homeserver, user and password:

```bash
curlew backends enable matrix
curlew accounts add matrix       # homeserver URL or server name, user, password
curlew sync
```

The login creates a **new device** named `curlew` (it appears in your
session list in Element and every other client) and uploads its encryption
keys. Only password login is supported: a homeserver that offers single
sign-on alone — matrix.org, since its move to the Matrix Authentication
Service — is refused with that reason for now.

Login and sync are quiet by default: the SDK's info and debug narration is
dropped, and only its warnings and errors reach stderr, with user, room and
event ids redacted. `CURLEW_MATRIX_LOG` changes that for a diagnosis — `debug`
or `trace` to see the SDK's own logging, `silent` to mute it; the output is
redacted at every level.

Encrypted rooms are decrypted where this device holds the room key. That is
every message sent **after** the login: senders encrypt for the new device from
then on, and its keys arrive with each sync. Messages sent **before** it show as
`[encrypted message: this device has no key for it]`: reading them needs your
server-side key backup or a verified session sharing its keys, and neither is
built yet. Curlew remembers such placeholders and tries them again on every
sync, so a key that arrives later still turns them into text.

Curlew never shows you as online (every sync says `set_presence=offline`) and
never sends a read receipt or a typing notice: a read-only gate refuses every
request outside login, the sync filter and the encryption key exchange before it
leaves the machine. Messages are no exception until you grant one: with a
`matrix.send` grant (see [Matrix](#matrix) under Sending) the granted room
alone becomes reachable, through a second gate that passes exactly one request —
the send of a plain-text message to that room — while the syncing side keeps
refusing every write. The device's crypto store is saved after every sync step,
before the server is told the keys arrived, so even a crash loses no key.

The first sync takes the newest 200 messages of every joined room, later syncs
walk forward. Edits and redactions arrive as events of their own and are applied
on the next sync — a message redacted on the server is removed from the index
without a full scan. Rooms you are only invited to are left alone.

The login leaves an **account file** at
`$XDG_DATA_HOME/curlew/secrets/matrix/matrix-<hash>.db` (mode `0600`). It holds
the access token and the device's crypto store (its identity keys and every room
key it received): back it up like a password. Losing it means a new login, a new
device, and no key for anything sent before it. To end the session, sign the
`curlew` device out in another client and delete the file.

