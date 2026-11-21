# ADR 0019: one process encrypts a Matrix send, and an encrypted room never sees cleartext

- **Status:** Proposed (2026-11-21). The first increment (the encrypting send path, encrypted
  media, the composer) is in the same change as this text. No live homeserver run yet.
- **Scope:** `@curlew/matrix` (`send.ts`, `content.ts`, `attachment-crypto.ts`, `client.ts`,
  `guard.ts`, `api.ts`, `session.ts`, `backend.ts`, `manifest.ts`, `map.ts`, `attachments.ts`),
  `app` (the composer's block list). Issue
  [#519](https://github.com/JumpLink/curlew/issues/519).
- **Builds on:** [ADR 0004](0004-sending-and-writing-granted-per-capability.md) (sending is granted
  per capability; amended here), [ADR 0007 §5](0007-live-updates-over-the-session-bus.md) (the
  daemon holds the live connections), [ADR 0010](0010-attachments-across-protocols.md)
  (attachments across protocols).

## Context

Matrix sending has been cleartext only since ADR 0004's matrix amendment: one
`PUT …/send/m.room.message/{txnId}`, and **a room carrying `m.room.encryption` was refused**. The
reason was not that encryption is hard but that the encrypting process has to be the right one.

Three facts constrain the design.

**The crypto store cannot have two owners.** The Rust crypto persists into an IndexedDB that
neither GJS nor Node has; `client.ts` installs an in-memory one and keeps its contents in the
account's secret file (`IndexedDbSnapshot`). Opening that store *deletes every IndexedDB under the
account's prefix* and restores it from the snapshot, which would wipe a running client's database.
`claimAccount()` therefore allows one live client per account per process — and between processes
the same problem exists one level up: two processes restoring and saving the same snapshot would
each hand back a device that has forgotten the other's keys, and a device whose one-time keys the
server already knows can never upload again (`MatrixKeysOutOfSyncError`).

**Megolm needs a sync loop.** A room key reaches other members as to-device messages, and the
device list a key is shared with comes from `/keys/query`. Only a client that syncs knows the
room's members, their devices and whether a Megolm session is still fresh. The cleartext send path
has none of that on purpose: no sync, no WASM crypto, no IndexedDB.

**Today's send path is the only one with a gate.** `readOnlyFetch` refuses every write for the sync
client; a granted send uses a second wrapper, `sendFetch`, built per permit around the permitted
room ids. The event type is named *literally* in that rule, so even a granted handle cannot `PUT`
an `m.room.encrypted`.

The question this ADR answers is therefore not "how do we encrypt" — matrix-js-sdk does that — but
**which process encrypts, what it is allowed to reach while it does, and what happens when it
cannot**.

## Decision

### 1. The process that holds the live client is the process that encrypts

`curlew daemon` holds the live connection of a followed account (ADR 0007 §5) and with it the only
Olm machine and crypto store of that account. An encrypted send runs *there*, on that client.

No new mechanism carries it: the Matrix manifest now declares `sendSharesReceiveState: true`, which
is the flag Signal and WhatsApp already use. `sendMessage` then asks the daemon **first**
(`routeThroughDaemon`), the daemon's handler opens a sender on the session it is holding
(`DeliverySession.openSender`), and only a `not-followed` answer lets the caller take its own
direct path. The receive lease the direct path takes afterwards is the lock that makes this safe
without a second one: a process holding the account holds the lease, so no two processes can be in
the crypto store at once.

**A second process never opens the crypto store to send.** It would cost a full first sync per
send (up to two minutes) and would have to restore and re-save the snapshot a daemon is using. So
the direct path keeps the cheap cleartext HTTP send and, for an encrypted room, refuses with a
reason that says what to do (`curlew daemon` is not running). This is a decision about cost, not
about capability; if a daemonless install turns out to need it, the escalation can be added
behind the same lease.

### 2. A room with `m.room.encryption` never gets a cleartext content event — four independent lines

1. **The sender asks before anything leaves.** `MatrixSender` resolves the room's encryption and
   refuses the send when the handle it was opened with cannot encrypt (`MatrixSendApi.canEncrypt`).
   The old `requireClear()` becomes encrypt-or-fail: the failure is a refusal with a reason,
   never a fallback.
2. **The question is answered by the crypto store, not by the server.** On the live client
   `CryptoApi.isEncryptionEnabledInRoom` is asked first: it is *persistent*, so a server admin who
   removes the `m.room.encryption` state event cannot downgrade a room back to cleartext. Only
   where no crypto is present does the state `GET` answer, and an unclear answer (not joined,
   server down) still refuses rather than assuming "unencrypted".
3. **The cleartext HTTP API refuses a room it has seen to be encrypted.** `matrixSendApi` caches
   every `isEncrypted` answer and throws before the `PUT` if a content event is about to go into a
   room on that list — the case a bug above would produce.
4. **The gate names the event type.** `sendFetch` keeps allowing only `m.room.message` and
   `m.reaction`, so the cleartext transport has no reachable endpoint for an `m.room.encrypted`
   either. The encrypted `PUT` goes out on the live client's own fetch, which is widened for
   exactly `PUT …/send/m.room.encrypted/{txnId}` and exactly the permit's rooms, for exactly as
   long as the sender handle is open (§5).

### 3. Device tracking, key sharing and rotation are the SDK's, and they happen before the send

`client.sendEvent` encrypts by itself in a room the crypto knows to be encrypted
(`encryptEventIfNeeded` → `cryptoBackend.encryptEvent`): it tracks the devices of the room's
`getEncryptionTargetMembers()`, establishes Olm sessions where they are missing, shares the current
Megolm session with every target device, and starts a new session when the room's
`rotation_period_msgs`/`rotation_period_ms` or a membership change requires it. Rotation is
therefore *not* curlew's policy; re-implementing it would only be a second, worse policy.

What curlew adds is one call before the send: `CryptoApi.prepareToEncrypt(room)`, which does the
device query and the session set-up ahead of the content event, so a first send into a large room
does not look like a hang. It is best-effort — a failure there fails the send with its reason, it
never turns into a cleartext send.

### 4. Unverified devices are encrypted to, and nothing is sent in the clear instead

Curlew has no device verification UI yet: no cross-signing, no emoji comparison, no device list.
With that missing, two policies are possible, and both are set explicitly rather than inherited
from an SDK default:

- `globalBlacklistUnverifiedDevices = false`
- `setDeviceIsolationMode(new AllDevicesIsolationMode(false))`

So a message is encrypted to **all devices of all joined members**, verified or not — Element's
default, and the only one that does not silently drop a recipient's second phone out of a
conversation. The alternative (blacklisting unverified devices) is strictly better *only* once the
person can verify devices; before that it would refuse almost every send in practice.

This is a trade the person should eventually own, so it is a **later setting**, not a later
default change: a per-account "only send to verified devices" switch, to be added together with
verification itself. Until then the honest summary is the one this ADR writes down — curlew
encrypts, and it does not yet tell you *who* it encrypted to.

### 5. The live client's gate is widened by a window, not by a rule

`readOnlyFetch` stays what it is: the sync client has no reachable write endpoint. Instead, the
live client is built on a fetch that consults the **send windows** currently open on it
(`liveFetch`). A window is opened by `openSender` for the permit's rooms and closed by that
handle's `close()`; while it is open the one extra request allowed is
`PUT …/rooms/{permitted room}/send/m.room.encrypted/{txnId}`. Everything else — every other method,
every other event type, every other room — is still decided by `refusal`.

Three properties worth the extra mechanism:

- the widening is **bounded in time** (the open handle) and **in scope** (the permit's rooms and
  one event type), where a rule in `refusal` would be permanent and account-wide;
- `m.room.message` is *never* added to it, so an encrypted send cannot degrade into a cleartext one
  by taking the wrong branch;
- the E2EE key protocol a send needs — `/keys/query`, `/keys/claim`, `PUT /sendToDevice/…` — is
  already on the read-only allowlist, because decryption needed it. Encrypting adds no key
  endpoint.

Refusals produced while a window is open are deliberately **not** written into the `refusals`
ledger. That ledger is what a sync run reads to prove it was never asked to write (`healthy()`
fails the run on any entry); a refused send already fails its own call loudly and must not take a
sync down with it. Same reasoning, and same note, as `sendFetch`.

### 6. An encrypted file is encrypted by curlew, and the event carries `file` instead of `url`

matrix-js-sdk ships no attachment-encryption helper in the build curlew uses, so
`attachment-crypto.ts` implements the client-server spec's `EncryptedFile` itself on WebCrypto —
AES-CTR-256 with a 16-byte counter whose low 64 bits start at zero, the SHA-256 of the
*ciphertext* in `hashes.sha256`, the key as an `A256CTR` JWK, `v: "v2"`. WebCrypto is the
web-standards path ADR 0001 §7 prefers, and it is the same `crypto.subtle` on both runtimes
(AES-CTR and SHA-256 are covered by gjsify's polyfill on GJS).

The media repository then receives **ciphertext** — the upload is unchanged, the bytes are not the
file. The content event carries `file: { url, key, iv, hashes, v }` and no `url` at top level, and
the thumbnail the same way in `info.thumbnail_file`.

Reading is the same code backwards: an attachment handle of an encrypted file carries the `file`
object next to the `mxc://` URI, and `MatrixAttachments` verifies the SHA-256 before it decrypts
and only then writes into the caller's sink — a file whose hash does not match is a corrupted or
tampered download and is refused, not shown. Verification needs the whole ciphertext, so an
encrypted download buffers up to the caller's `maxBytes` instead of streaming; that limit is what
bounds it.

**The per-file key is stored in the index**, inside the attachment handle. That is not a new tier:
the index already holds the *decrypted text* of every encrypted room curlew could read, so the
media key of an attachment next to it widens nothing. The Megolm room keys stay where they are —
in the account's secret file, with the crypto store they only mean something together with.

### 7. The permit and the guarded fetch stay exactly what ADR 0004 made them

Nothing about the grant changes. `matrix.send` still names `<account>/<room id>`; the permit is
still re-checked inside the sender, which is the second check after the frontend's; the daemon's
handler opens the sender with the permit the caller was granted and not with a wider one. The
encrypted path is a different *transport for the content event*, reached only through a handle
that already passed all of it.

Reactions, redactions and private read receipts stay cleartext, because Matrix makes them so:
`shouldEncryptEventForRoom` returns false for `m.reaction` and for redactions, since the server has
to see the relation to apply it. They carry an event id and an emoji, never a body. The
never-cleartext rule of §2 is therefore about **content events** — `m.room.message`, files and
their edits — and says so where it is implemented.

## Consequences

- An encrypted room is sendable from the composer, the CLI and an agent with the grant, whenever
  the account is followed by a running daemon. The composer's "Encrypted rooms are not supported
  yet" block goes away; a send without a daemon fails with a sentence that names the daemon.
- The send path is no longer one path. The cleartext HTTP sender keeps every unencrypted room and
  every reaction, redaction and receipt; a content event in an encrypted room goes through the live
  client. One sender object, two transports, one permit.
- The daemon does more than it did: it now holds the only writing crypto store of the account. A
  daemon that is not running is not just a slower send, it is no encrypted send at all — which is
  the trade §1 accepts.
- `MATRIX_MANIFEST.capabilities.e2ee` finally means both directions. Its comment stops saying
  curlew only decrypts.
- No wire change. `DaemonSendStep.sent.encrypted` already crosses the session bus, so the daemon
  can report an encrypted send to the caller that logs and indexes it; `DAEMON_WIRE_VERSION` stays
  at 8.
- Device verification is the next thing this makes conspicuous. Encrypting to unverified devices is
  the right default without a verification UI and the wrong one with it.

## Alternatives considered

**Encrypt in the sending process, lease the crypto store.** The lease already exists and would
serialize access, so correctness is reachable. Rejected for cost: every send would restore the
snapshot, open the WASM crypto, run a first sync to learn the device list, send, save and tear
down — seconds of work and a full key-upload risk window for one message, and the common case
(a daemon is running) would pay it for nothing.

**Keep refusing, and tell people to use Element.** What this replaces. Honest, but it makes every
encrypted room — which is every new direct chat on most homeservers — read-only in curlew.

**Widen `sendRefusal` to allow `m.room.encrypted`.** Simpler than a window, and it was the obvious
first shape. Rejected because it widens the *cleartext* transport, whose whole value is that it
cannot carry an encrypted event, and because it would be permanent where a window is only open
while a granted handle is.

**Blacklist unverified devices.** Cryptographically the stronger default, and unusable before
verification exists: it would refuse to reach most recipients' devices, with no way for the person
to fix it from curlew. Written down as the setting it should become (§4).
