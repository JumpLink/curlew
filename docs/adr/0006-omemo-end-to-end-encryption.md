# ADR 0006 — OMEMO end-to-end encryption for XMPP

- **Status:** Accepted (2026-10-11)
- **Scope:** new `@curlew/omemo`, `@curlew/xmpp`, `@curlew/store` (`SecretStore`), `app` (`curlew send`,
  `curlew sync`, `curlew daemon`, CLI + MCP), gjsify (`@gjsify/webcrypto` / `@gjsify/crypto`)

## Context

XMPP in curlew carries more than the assistant's account (ADR 0004). It will carry ordinary
person-to-person chats, and the people on the other side use **Conversations** (Android) first,
then Dino, Gajim and Monal. All four encrypt with OMEMO (XEP-0384) by default. Today curlew
detects an `<encrypted>` element (`packages/xmpp/src/stanza.ts`) and indexes the message
without text (`map.ts`); it can neither read nor write an encrypted chat. For normal chats that
makes curlew useless, so OMEMO is required. The owner decided the frame:

- curlew stays on **xmpp.js 0.14**. Other JS stacks (Strophe, Ethora) and JS Signal/OMEMO
  libraries are inspiration unless a dependency is clearly better.
- OMEMO becomes its own package, modelled on **Dino's OMEMO plugin** (`plugins/omemo/`, in
  `refs/dino`).
- Crypto missing on GJS is added to **gjsify**, with tests, not shimmed here (ADR 0001 §7).
- Keys and sessions live in curlew's **secret store** (`secrets/xmpp/<account>.db`, 0600 in
  0700), never in the index.

### What the clients speak today (checked 2026-10-11)

XEP-0384 is at **0.9.1** (2026-04-06, Experimental). Its namespace has been `urn:xmpp:omemo:2`
since **0.8.0** (2021-09-28): XEP-0420 SCE envelopes, Ed25519 identity keys on the wire,
AES-256-CBC + HMAC-SHA-256 (truncated to 16 bytes) for both payload and ratchet, one
`urn:xmpp:omemo:2:bundles` node with one item per device. The version still deployed is
**0.3.0** (2018-07-31), namespace `eu.siacs.conversations.axolotl`: a body-only payload
encrypted with **AES-128-GCM**, a key element carrying `key ‖ tag` (32 bytes), a Curve25519
identity key with XEdDSA signatures, libsignal's protobuf wire format, a
`….devicelist` node and one `….bundles:<device id>` node per device. Every public key in a
0.3.0 bundle is published as libsignal serializes it, 33 bytes with the `0x05` type byte: Dino
reads a bare 32-byte key as the OMEMO 2 Ed25519 form and converts it, which breaks the session
and shows a fingerprint that is not ours (found in the Dino interop run).

| Client | Source checked | Namespace in the code |
|---|---|---|
| Conversations 2.20.4 | `master` on Codeberg (pushed 2026-10-07): `xml/Namespace.java`, `crypto/axolotl/AxolotlService.java` | `eu.siacs.conversations.axolotl` only; no `urn:xmpp:omemo:2` anywhere in `Namespace.java`. AES/GCM with a 12-byte IV (`XmppAxolotlMessage.generateIv`; CHANGELOG 2.7.0 "Use 12 byte IVs for OMEMO" — older messages carry 16-byte IVs); 100 prekeys (`NUM_KEYS_TO_PUBLISH`) |
| Dino 0.5.1 (2025-11-15) | `master`, `plugins/omemo/src/protocol/stream_module.vala` | `NS_URI = "eu.siacs.conversations.axolotl"`; 16-byte key, 12-byte IV, AES-GCM (`logic/encrypt.vala`). A branch `feature/omemo1` exists, unmerged |
| Gajim 2.6.0 (2026-08-26) | GitHub mirror: `pyproject.toml` (`omemo-dr`), nbxmpp `namespaces.py` | `OMEMO_TEMP = "eu.siacs.conversations.axolotl"`; `urn:xmpp:omemo:2` appears only in a label table in `const.py` |
| Monal (Build_iOS_1098, 2026-10-07) | GitHub code search over `monal-im/Monal` | legacy namespace in 5 files (`MLOMEMO.m` …); zero hits for `urn:xmpp:omemo:2`; rejects IVs other than 12 bytes |

QXmpp knows all three namespaces, but it is not one of our peers. **Not verified:** Monal and
Gajim from a running build (code search only; GitHub's index can lag), whether Dino's
`feature/omemo1` is still alive, and Monal interop at all (no iOS device for a test).

### What gjsify has today

Checked in `gjsify/gjsify` at `37a99c50ae` (v0.59.1-3). `@gjsify/webcrypto`'s `SubtleCrypto`
implements, each with specs: **X25519** (`deriveBits`, import `raw` public / `pkcs8` / `jwk`),
**Ed25519** sign/verify (RFC 8032), **AES-GCM**, **AES-CBC**, **AES-CTR**, **HKDF**, **HMAC**,
SHA-256, `getRandomValues`. `@gjsify/crypto` (`node:crypto`) has the curve code in one place
(`curve25519.ts`: `ed25519Sign(seed, …)`, `ed25519Verify`, `x25519SharedSecret`) and the AES
modes in `cipher.ts`. Missing for OMEMO:

1. **XEdDSA** sign and verify (signing an Ed25519-verifiable signature with a Curve25519
   private key, and checking one against a Curve25519 public key). Needed for every legacy
   signed prekey: ours to publish, the peer's to check. `ed25519Sign` takes an RFC 8032 seed;
   XEdDSA needs signing from a scalar, which nothing exposes.
2. **The birational map** Curve25519 ⇄ Ed25519 (public key, and private scalar from an
   Ed25519 seed), RFC 7748 §4.1. Needed by XEdDSA verify and by OMEMO 2's Ed25519 identity.
3. **AES-GCM with an IV other than 96 bits.** `cipher-utils.ts` fixes `ivSize: 12` and `cipher.ts`
   builds J0 as `IV ‖ 0³¹ ‖ 1` only; the GHASH-derived J0 of NIST SP 800-38D is absent. Needed
   to read 16-byte-IV messages that pre-2.7.0 Conversations put into archives. WebCrypto allows
   any IV length, so this is a conformance bug, not an extension.

Everything else — raw X25519 private keys go in as a `pkcs8` wrapper, protobuf is a handful of
fields — needs no platform work. Items 1 and 2 are not WebCrypto algorithms, so they cannot hide
behind `crypto.subtle`; they go into a small new gjsify package of their own (see Owner decisions).

## Decision

### 1. Namespace: legacy `eu.siacs.conversations.axolotl` only, OMEMO 2 behind a seam

curlew implements **OMEMO 0.3 (`eu.siacs.conversations.axolotl`) and nothing else** in the first
release. Every peer the owner named sends and accepts only that namespace today; an
OMEMO 2-only curlew could talk to none of them, and a dual stack doubles the device lists,
bundles and trust records for a counterpart that does not exist yet.

`@curlew/omemo` keeps the version apart from the logic, the way Dino's plugin separates its
stream module from `logic/`: device list, bundle, wire format, payload cipher and X3DH/KDF
constants form one **profile** (`legacy` now, `v2` later); the stores, trust, the ratchet and
the session lifecycle are shared. `urn:xmpp:omemo:2` gets its own ADR when Conversations ships
it. Until then a received OMEMO 2 message is indexed as today, marked `undecryptable: v2`.

*Rejected:* OMEMO 2 first (no peer); both at once (twice the state and tests for zero interop
gain today).

### 2. Our own package and our own code, gaps in gjsify

`packages/omemo` (`@curlew/omemo`, LGPL-3.0-or-later) holds X3DH, the Double Ratchet, the
legacy wire format (a hand-written protobuf codec for the few `SignalMessage` /
`PreKeySignalMessage` fields; no protobufjs), the payload cipher, trust and the stores'
interfaces. It is **pure**: no `@xmpp/*`, no `SecretStore`, no `gi://`. It sees
`crypto.subtle` plus the gjsify additions above, and a storage port. `@curlew/xmpp` adapts it:
stanzas, PEP, the `SecretStore` behind the port. The three gjsify items are gjsify work items,
each with RFC/NIST test vectors; curlew bumps gjsify to pick them up. A temporary shim is
marked `// gjsify gap (unfixed, <PR>)` as `AGENTS.md` requires.

Libraries considered:

| Candidate | Licence | Verdict |
|---|---|---|
| `@signalapp/libsignal-client` 0.105 (already in `@curlew/signal`) | AGPL-3.0-only | Rejected: current libsignal requires PQXDH — `rust/protocol/src/session.rs` returns `InvalidMessage` for `CIPHERTEXT_MESSAGE_PRE_KYBER_VERSION` — so it cannot speak OMEMO; also AGPL in an LGPL package and N-API |
| `@privacyresearch/libsignal-protocol-typescript` 0.0.16 / `libsignal-protocol` 1.3.15 | GPL-3.0(-only) | Rejected: GPL cannot sit in an LGPL package; pre-1.0, little maintenance; Signal-shaped stores we would wrap anyway |
| `@noble/curves` 2.4 | MIT, audited (Cure53, Trail of Bits) | Not a curlew dependency. A good **reference and test-vector source** for the gjsify work (`ed25519.utils.toMontgomery`); whether gjsify implements on top of it is gjsify's decision |
| Strophe/Ethora OMEMO plugins, python-omemo/oldmemo/twomemo | various (oldmemo AGPL-3.0, twomemo MIT) | Inspiration and, for oldmemo, a **fixture generator** in the test tooling (never bundled) |

The ratchet is a few hundred lines over primitives gjsify already has; a dependency would add a
licence or a native addon and still leave XEdDSA open.

**Licences.** Dino (and Conversations) are GPL-3.0. They are a design reference: we read
structure, constants and business rules, and copy no code. Facts such as namespaces, KDF info
strings, key sizes and protocol behaviour are not copyrightable expression; translated Vala or
Java would be a derivative work and would force `@curlew/omemo` to GPL. Reviewers check new
OMEMO code against that line.

### 3. Keys in the account's secret file, and a rotation the receiver owns

The XMPP account's existing secret file (`secrets/xmpp/xmpp-<hash>.db`) gets these namespaces;
bytes are base64 (`SecretStore` stores TEXT only):

| Namespace | Key → value |
|---|---|
| `omemo.device` | `id` → our device id (random, 1…2³¹−1, checked against our own list before first publish); `identity` → identity key pair; `registration` → libsignal registration id |
| `omemo.signed-prekey` | `<id>` → key pair, signature, created-at; `current` → id |
| `omemo.prekey` | `<id>` → key pair; `next-id`; `<id>:consumed-at` while deletion is deferred (below) |
| `omemo.session` | `<bare jid>:<device id>` → ratchet state, skipped message keys (at most 1000 per session, FIFO), the pending key-exchange header |
| `omemo.identity` | `<bare jid>:<device id>` → identity public key, trust, first seen |
| `omemo.devices` | `<bare jid>` → cached device list, fetched-at |

Nothing OMEMO-related enters the index, a DTO, a log line or MCP output, fingerprints aside
(§4). The backup tier stays `secret`.

- **Signed prekey:** rotated every **7 days**, the previous one kept one more period for
  delayed key exchanges (XEP-0384 4.2: weekly to monthly).
- **Prekeys:** 100 published; a key exchange consumes one; when fewer than 75 remain, the bundle
  is topped up to 100 and republished. Received during a MAM catch-up, a consumed prekey's
  private part is deleted only **after** the catch-up, followed by an empty OMEMO message to
  move the session off a possibly double-used prekey (XEP-0384 §6).
- **Own device list:** on every connect of the publishing process, and on every PEP update of
  our own list, our id must be in it; if not, it is re-added (§5.3.1). Nodes are published
  with `access_model=open`.

### 4. One state, two processes: ratchet steps are transactions in the secret file

`curlew daemon` (follow mode) and `curlew send` / `send_message` are separate processes on the
same account, and `send` already works while the daemon runs (#79). A Double Ratchet session
changes with every message in either direction. Two processes that each load it, step it and
write it back fork it: one side's chain keys vanish and the peer's next message fails to
decrypt — silent loss, which is worse than a lock.

**Rule:**

1. **Every ratchet step is load → step → save inside one `BEGIN IMMEDIATE` transaction on the
   account's secret file**, and no process keeps session state in memory between two steps.
   `SecretStore` gets a `transaction(fn)` for this; `get`/`apply` alone cannot express a
   read-decide-write. Network I/O (fetching device lists and bundles) happens before the
   transaction, never inside it; the step itself is milliseconds.
2. **Only the receive-lease holder decrypts, publishes, rotates and replenishes.** That is the
   daemon for a followed account and `curlew sync` otherwise. A receive consumes our prekeys and
   publishes PEP items, so for an account with OMEMO on, `curlew sync` takes the receive lease
   (ADR 0002 §4) exactly as it does for a delivery account, and stands down when a daemon holds
   it.
3. **Any granted process may encrypt.** `curlew send` encrypts under rule 1 without the lease:
   it builds or steps sessions with the peer's and our other devices, never touches our own
   prekeys or bundle, and never decrypts.

*Rejected:* routing `send` through the daemon (no IPC exists, and `send` must keep working
without a daemon); `send` taking the receive lease (the daemon holds it for as long as it
runs); a separate lock row in the index (a second database to coordinate with, when the state
already lives in one SQLite file that can lock itself).

### 5. Becoming a device is a grant: `xmpp.omemo`

Decrypting is impossible without publishing a device: a peer encrypts only for devices on our
list. Publishing one is a write with reach — every contact's client starts encrypting for it,
and the person's other clients announce a new device. Session upkeep also sends stanzas: empty
OMEMO messages that complete a key exchange, and heartbeats after 53 messages (XEP-0384 §6).
ADR 0004 says nothing sends without a grant, so this is a new capability row:

| Capability | Target | Allows |
|---|---|---|
| `xmpp.omemo` | an account | publishing curlew's device and bundle on that account, and the empty OMEMO messages that maintain its sessions — with any peer, since they carry no content |

Without it, curlew stays what it is today for that account: encrypted messages are indexed
without text. `xmpp.omemo` does **not** allow content: an encrypted message with a body still
needs `xmpp.send` for that exact `<account>/<address>`.

### 6. Trust: blind trust before verification, decided by a human only

curlew follows **BTBV** as Conversations implements it (`SQLiteAxolotlStore.saveIdentity`): a
new identity key of a contact is trusted blindly **unless that contact already has a verified
key**, in which case it stays undecided. The same holds for our own other devices. States per
`<jid>:<device>`: `undecided`, `blind`, `verified`, `distrusted`.

- **Sending** encrypts only for `blind` and `verified` devices (XEP-0384 §8 forbids using a
  session before trust is established; BTBV is the trust decision the 0.9 text explicitly
  allows).
- **Receiving** decrypts from every device, including `undecided`, and stores the sender
  device's trust with the message, so a reader sees *verified*, *blind* or *untrusted*.
- **Fingerprint:** the 32-byte Curve25519 identity key as lowercase hex in 8 groups of 8, the
  form XEP-0384 §8 recommends and Conversations and Dino display.
- **CLI:** `curlew omemo devices <account> [<jid>]` lists devices, fingerprints and trust;
  `curlew omemo trust <account> <jid> <fingerprint> verified|distrusted` changes one, and
  `curlew omemo reset <account> <jid>` replaces broken sessions (XEP-0384 §6 makes a manual
  reset a MUST). Changing trust needs an interactive terminal and the fingerprint typed back.
  That is a speed bump against an agent with a shell, not a boundary; the boundary is that no
  grant exists for it. **As built in stage 4** all three take flags, not positionals —
  `--account`, `--jid`, `--fingerprint`, `--state` — because `omemo devices` from stage 2
  already did and one command group should read one way.
- **MCP:** a read-only `omemo_devices` tool (`readOnlyHint: true`) shows fingerprints and trust.
  **No MCP tool changes trust, resets a session or turns encryption off — with or without a
  grant**, and no capability for it is defined. An agent reads message text written by others;
  a message that talks it into "verifying" an attacker's key would hand over every later
  message. Verification compares a fingerprint over a second channel, which only the person
  can do.
- A changed identity key for a known device is never silent: it becomes a
  `presentation: 'notice'` message in that chat, as Signal's does.

### 7. Sending: encrypt when the peer has OMEMO, never fall back silently

For a granted `<account>/<address>` (ADR 0004), `curlew send` fetches the peer's device list
(cached in `omemo.devices`). The peer's list is asked for on every send, so a device they
added is addressed at once; the cache answers only when the server does not. Our own list is
refreshed when older than one hour. A message that arrives from a device missing in the cached
list of its sender drops that cache, so the next send asks the server:

| Peer state | What happens |
|---|---|
| devices listed, at least one `blind`/`verified` | encrypted for those devices and our own other trusted devices; the plaintext `<body>` carries only the usual "encrypted message" fallback |
| devices listed, none trusted | **refused**, naming the undecided fingerprints and the CLI command |
| no device list (item-not-found) | plaintext, as today — the peer cannot read OMEMO |
| list fetch failed (timeout, server error) | **refused** — "unknown" never becomes "plaintext" |
| `xmpp.omemo` not granted for the account | plaintext only to a peer without devices; refused otherwise |

**As built in stage 3, the last row sends plaintext in both cases.** Without the grant curlew
holds no keys, publishes no device of its own and never looks a peer's list up, so it cannot
tell a peer with devices from one without — and the owner decision "with no grant, behaviour
stays exactly as today" outranks refusing. The row describes what a later stage could do once
an ungranted account is allowed to read a device list.

**Stage 4 narrows that one case:** a peer listed in `config.encryption` is refused before the
connection when its account has no `xmpp.omemo` grant, naming both ways out (grant it, or drop
the peer from the setting). Plaintext stays the default everywhere the person did not ask for
`required`, so "no grant, behaviour as today" still holds for every other peer.

A peer that once had OMEMO and later publishes an empty list gets plaintext again only after a
notice in that chat. A per-address `encryption: "required"` setting in the config can forbid
plaintext entirely: with the grant, an empty device list is refused (`encryption-required`)
instead of falling back.

### 8. Indexing: decrypted text is indexed, and becomes `state`

A decrypted body is indexed like any plaintext chat message — the index already holds mail
bodies, at 0600 — with the sender device's trust beside it. Searching it is the point of
curlew. Three consequences:

- **The index is no longer rebuildable for OMEMO chats.** Forward secrecy deletes message keys
  once used, so MAM keeps ciphertext nobody can decrypt again. The decrypted row is the only
  readable copy: `state`, like a delivery-only message (ADR 0002). With `xmpp.omemo` granted,
  the "never delete and rebuild the index" rule applies, and `.werkstatt-state.json` changes
  the index's tier accordingly.
- **Order: decrypt → write the index row → commit the ratchet step.** Both are SQLite files,
  with no shared commit; the ratchet transaction (§4) stays open while the row is written and
  commits after it. A crash in between leaves the session unadvanced, so the next catch-up
  decrypts again and the archive id deduplicates. The other order loses the message.
- **Our own sent messages.** curlew does not encrypt for its own device, so the MAM echo of what
  it sent is unreadable to it. `recordDelivered` stores the plaintext at send time and the
  echo, matched by origin id (ADR 0004 §5), must never overwrite that text with null. A failed
  index write after an encrypted send therefore loses the local copy (the write log holds no
  text): `send` retries the index write before reporting `indexError`.

**Undecryptable** messages are indexed as today, without text, with a reason:
`not-for-this-device` (sent before curlew was a device, or the sender did not trust it yet —
permanent), `no-session`, `bad-mac`, `v2`. A duplicate of a message already decrypted is
dropped silently (XEP-0384 §6). A decryption error never starts a new session automatically
(§8 there).

**MAM catch-up** decrypts in archive order, inside the lease (§4): a key exchange met there
defers prekey deletion until the page loop ends. **Carbons and MAM copies of messages sent from
the person's other devices** are decrypted with the session to that own device when it
encrypted for us, and stored as outgoing; otherwise `not-for-this-device`.

## Rollout

Each stage is shippable on its own; the smallest useful one first. Stages 0–4 are **done**.

0. **gjsify:** XEdDSA, the Curve25519 ⇄ Ed25519 map, AES-GCM with any IV length — each with
   test vectors (RFC 7748, RFC 8032, the XEdDSA spec's construction, NIST GCM vectors with a
   non-96-bit IV). curlew bumps gjsify.
1. **`@curlew/omemo` core:** X3DH, the ratchet, the legacy wire format and payload cipher, the
   storage port. Unit-tested against fixtures (below); no network.
2. **Receive and decrypt 1:1** behind `xmpp.omemo`: device and bundle publishing, rotation,
   replenishment, BTBV, `curlew omemo devices` and the read-only MCP tool, in `sync` and in the
   daemon's follow mode.
3. **Send encrypted** to a granted address with the policy of §7; empty OMEMO messages and
   heartbeats.
4. `curlew omemo trust` / `reset`, identity-change notices, the `encryption: "required"`
   setting.

### Tests

- **Primitives** in gjsify, with published vectors.
- **Protocol** in curlew, against **recorded fixtures**: a script under `app/tests/fixtures/`
  tooling (never bundled) drives python-oldmemo — libsignal-compatible and used by real clients
  — with fixed keys and synthetic `example.org` JIDs, and records bundles, key exchanges and
  messages in both directions. Tests check: we decrypt theirs, they decrypt ours (the script
  replays our output), skipped and out-of-order keys, a 16-byte-IV payload, a duplicate, a
  wrong MAC, a v2 element.
- **Concurrency:** two processes stepping one session under §4 never lose a message — the same
  cross-process harness that measured the lease (`concurrency.test.ts`).
- **Live interop**, by hand before each release that touches OMEMO: a throwaway local server
  (Prosody or ejabberd with PEP `persistent-items`, publish-options, `open` access), synthetic
  accounts, and Conversations (on an emulator), Dino and Gajim — first contact both ways, BTBV,
  verification, a carbon from the person's other client, a MAM catch-up after downtime. The
  checklist lives with the tests ([`app/tests/interop/CHECKLIST.md`](../../app/tests/interop/CHECKLIST.md),
  the lab: `omemo-lab` next to it). Monal is not tested until someone has an iOS device.

### Out of scope

Group chats (MUC OMEMO, XEP-0384 §5.8); encrypted files (`aesgcm://`, XEP-0454); Jingle (JET,
call verification); OMEMO 2 (`urn:xmpp:omemo:2`, §1); signed device labels (v2 only);
OpenPGP (XEP-0027/0373); restoring an old secret file — it breaks sessions by design, and
`curlew omemo reset` is the cure.

## Consequences

- curlew can read and write the chats the owner's contacts actually have, with the peers they
  actually run.
- An account with `xmpp.omemo` makes the index irreplaceable for its chats; backups must cover
  it like a delivery-only one.
- curlew carries its own implementation of security-critical code. The fixture suite and the
  interop checklist are what keep it honest; a second reviewer for `@curlew/omemo` is
  expected.
- When Conversations ships `urn:xmpp:omemo:2`, curlew adds the `v2` profile and has to answer
  the dual-stack question this ADR deferred.
- gjsify gains XEdDSA, the curve map and full AES-GCM — reusable by any GJS app.

## Owner decisions (2026-10-11)

1. `xmpp.omemo` is a capability of its own (§5). `xmpp.send` does not imply it.
2. The person's own accounts may become OMEMO devices, but only where `xmpp.omemo` is granted
   for that account. Nothing becomes a device by default.
3. Plaintext to a peer that has no OMEMO is the default (§7); an account can set `required`.
4. The index becomes `state` for OMEMO chats (§8); the deployment's backup must cover it.
5. XEdDSA and the Curve25519⇄Ed25519 map go into a small new gjsify package, not into
   `@gjsify/webcrypto` or `@gjsify/crypto`: neither is WebCrypto or `node:crypto`. The AES-GCM
   IV fix stays in `@gjsify/webcrypto`, where it is a conformance bug.

## References

- XEP-0384 0.9.1 <https://xmpp.org/extensions/xep-0384.html>, 0.3.0
  <https://xmpp.org/extensions/attic/xep-0384-0.3.0.html>; XEP-0420 SCE; X3DH, Double Ratchet,
  XEdDSA specifications (signal.org/docs)
- Conversations `master` (Codeberg): `xml/Namespace.java`, `crypto/axolotl/*`, `CHANGELOG.md`
- Dino `master`: `plugins/omemo/` (also `refs/dino`); Gajim `pyproject.toml`, nbxmpp
  `namespaces.py`; Monal `Monal/Classes/MLOMEMO.m`
- libsignal `rust/protocol/src/session.rs` (pre-Kyber messages rejected)
- ADR 0001 §7 (gaps in gjsify), ADR 0002 §4 (the lease), ADR 0004 (grants)
