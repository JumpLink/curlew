# AGENTS.md — curlew

Operating guide for AI agents in the **curlew** repo. Follows the
[agents.md](https://agents.md/) convention; the human overview is [README.md](README.md).
This repo is a submodule of **werkstatt**, whose [AGENTS.md](../../AGENTS.md) carries the
broader workspace rules — this file is the curlew-specific layer and wins where they differ.

> **Curlew was `postbote` — "formerly postbote".** Identifiers, packages, binary and MCP server
> are `curlew`. The old `postbote` name survives only in persisted formats and the data-directory fallback (see below). Do not "fix" it.
>
> **The rename fallback is load-bearing — do not "simplify" it away.** `dataDir()`/`configPath()`
> use `$XDG_{DATA,CONFIG}_HOME/curlew/`, but when ONLY the old `postbote/` directory exists it is
> read and written in place (`homeSubdir` in `packages/store/src/paths.ts`): never moved, never a
> second directory beside it, ONE notice line on stderr. Delivery-only messages there are the only
> copy. The old `POSTBOTE_*` variables are still read (`envValue`; `CURLEW_*` wins). The on-disk
> namespaces inside account and secret files (`postbote.account`, `postbote.matrix`,
> `postbote.undecryptable`, `postbote.api`) and the Matrix IndexedDB name `postbote-<account>` are
> FORMAT keys of existing files and stay. There is no libsecret/keyring use in this repo. Pinned by
> `app/tests/unit/store/paths.test.ts` — the old-install case, not only a fresh one.

## What this is

Mail (IMAP), contacts (CardDAV) and calendar (CalDAV) through **GNOME Online Accounts**, as a
CLI and an MCP server. A TypeScript monorepo that **runs on GJS via gjsify** (not Node),
following the buchhaltung/leitstand pattern: pure-TS `packages/*` + one `app` workspace that
carries the gjsify toolchain and picks a frontend at the yargs entrypoint.

The code came out of `buchhaltung/packages/gnome`; the git history there is the deeper record.

**The index and the MCP server are read-only and fail-closed.** IMAP is spoken with `BODY.PEEK`
only, so `\Seen` is never set; there is no flag write, no move, no delete, and no MCP tool that
sends. **Sending exists as a library capability only** — `@curlew/smtp` — and the caller uses it
only with the human's explicit consent for that message. It has no MCP tool and no CLI command.
Write access for agents needs its own decision, taken when it is wanted; this package does not
make it.

## Package layout — and the one rule that holds it together

| Package | Contains | May import |
|---|---|---|
| `@curlew/protocol` | **Pure.** RFC grammar (IMAP lexer, ENVELOPE, FETCH, LIST, BODYSTRUCTURE, MIME, RFC 2047/2231, modified UTF-7), DTOs, errors, the plugin API: `MessageBackend` port + manifest, `BackendContext`, the `MailBackend` mailbox driver and the `ChatBackend` chat driver | nothing |
| `@curlew/gnome` | GOA + EDS: accounts, contacts, calendar, IMAP credentials | `protocol`, `gi://` |
| `@curlew/imap` | Gio TLS transport, IMAP client, folders, search, fetch, attachments | `protocol`, `gnome`, `gi://` |
| `@curlew/smtp` | Sending ONE message with attachments over SMTP on nodemailer (pinned exactly): message building, account validation, `verifyAccount`, `sendMessage`, `SmtpError`. A library capability — no MCP tool, no credential in a log, error or DTO; `security: 'none'` for loopback only. TLS and STARTTLS are tested against a loopback dummy server | nodemailer, `node:*` — no `gi://`; imports no other package |
| `@curlew/store` | SQLite index, sync engines (mailbox + chat), conversations (threading, classification), secret store, XDG paths, file writes | `protocol`, `node:*` |
| `@curlew/telegram` | Telegram `chat` backend on mtcute (web build: WebSocket, WebCrypto, WASM), its session storage on `SecretStore`, the login | `protocol`, `store`, `@mtcute/*`, `node:*` — no `gi://` |
| `@curlew/whatsapp` | WhatsApp `delivery` backend on Baileys (unofficial protocol: WebSocket, WASM, libsignal), its auth state on `SecretStore`, the QR / pairing-code link | `protocol`, `store`, `baileys`, `node:*` — no `gi://` |
| `@curlew/signal` | Signal `delivery` backend on `@signalapp/libsignal-client` (Rust behind N-API; on GJS through `@gjsify/napi`, loaded on first use), its protocol stores on `SecretStore`, the QR link as a linked device, the fail-closed request gate | `protocol`, `store`, `@signalapp/libsignal-client`, `qrcode-generator`, `node:*` — no `gi://` |
| `@curlew/xmpp` | XMPP `chat` backend on xmpp.js (composed by hand: domain-checked direct TLS, WebSocket, SCRAM), history from MAM only, the account file on `SecretStore`, the login. NEVER sends presence, markers or messages | `protocol`, `store`, `@xmpp/*`, `node:*` — no `gi://` |
| `@curlew/matrix` | Matrix `chat` backend on matrix-js-sdk + the Rust crypto as WASM (`@matrix-org/matrix-sdk-crypto-wasm`), its crypto store as an in-memory IndexedDB snapshotted into `SecretStore`, the password login | `protocol`, `store`, `matrix-js-sdk`, `@matrix-org/*`, `fake-indexeddb`, `node:*` — no `gi://` |
| `curlew-cli` (`app/`) | yargs CLI + MCP server, config file, backend registry | all of the above |

**`store` must never import a backend** (`imap`, `telegram`, `xmpp`, `matrix`, `signal`, …). The sync engines are driven
through the driver ports declared in `protocol` (`MailBackend`, `ChatBackend`) and injected by
`app`. That keeps `store` free of `gi://` and of any network library even transitively, which
is the only reason the sync algorithms — the most intricate part of this project — can be
unit-tested on Node against a fake backend and `:memory:`. If you find yourself wanting to
import a backend from `store`, add a method to the port instead.

**`@curlew/whatsapp` is imported by nothing but the app's registry** (`builtin.ts`) — no
other package, no shared helper pulled out of it into `store` or `protocol`. WhatsApp is an
unofficial protocol against WhatsApp's terms (ADR 0001 §5): if a takedown or ban wave makes it
necessary, the package must move to its own repository in one step. Anything it needs from the
rest goes through the ports; duplicate a ten-line helper rather than share it.

**File naming carries meaning:** a file containing a `gi://` import is named `*.gjs.ts`.
Everything else is pure and must stay runnable on Node. Packages that need both ship a
`package.json` `exports` map (`browser` → `index.gjs.ts`, `node`/`default` → a stub that throws
`GnomeUnavailableError`), so `gi://` never enters a Node bundle.

**The one exception is `@curlew/gnome`, which has no exports map and one `src/index.ts` for
every runtime.** The Node stub it used to have hid a distinction that mattered: GOA/EDS work on
Node too, through `@gjsify/node-gi`, which resolves `gi://` with GJS semantics. GJS on
Linux/GNOME is still the supported runtime; the Node path is groundwork for a macOS/Windows
port. The `.gjs.ts` infix stays on its files, because they hold `gi://` imports.

- **GOA/EDS typelibs are OPTIONAL and load on first use, on EVERY runtime.** `libs.gjs.ts` wraps
  each namespace in `optionalNamespace` (`optional.ts`): the `gi://` import is a dynamic
  `import()` the bundler leaves alone, so a host without `libgoa`/`libedataserver` (macOS, a
  plain container) still starts, and the first call that needs one rejects with
  `GnomeUnavailableError`. `check()` reports it instead of throwing. Never add a top-level
  `gi://Goa|EDataServer|EBook|ECal` value import or a module-scope `Gio._promisify(...)` on those
  namespaces: either one resolves the typelib at load and takes the whole app down.
  `app/tests/unit/gnome/optional.test.ts` pins it on both runtimes.
- **One failure, one type.** A missing typelib is a `GnomeUnavailableError`; every other native
  failure (no session bus, a connect that never answers) leaves the public entry points as a
  `GnomeError` naming the call, with the GError domain and code set (`errors.ts`). A raw GJS
  `GLib.Error` is a boxed GObject, not an `Error`, and JSON-serialises to `{}`.
- **The Node bundle has a real dependency the source never imports**: `@gjsify/node-gi`. Its
  `gi://` shim stays an external import in the output, which is why it is a `dependencies` entry
  of `@curlew/gnome`.

`@curlew/imap` keeps its split: its Gio TLS transport needs GJS. Do not assume the move
generalizes.

## Run / build / test

- Deps: **`gjsify install`** — NEVER `npm install`, it prunes gjsify deps. Node 24 to bootstrap
  (gjsify's install-backend prebuilds target 24; Fedora's 22 segfaults).
- All eight `@gjsify/*` packages are pinned to the **same exact version**. gjsify ships as one
  release train and a CLI ↔ libs skew produces silently broken bundles. Bump them together.
- `typescript` is pinned `^6.0.3`, **not** 7: `gjsify tsc` does not use this dependency, it
  runs a bundle with TypeScript 6.0.3 baked in. A local 7 would give a different diagnostic set
  than CI — green locally, red in CI.
- Use gjsify's own workspace feature, not npm's: `gjsify foreach -A <script>` (the `-A`
  includes `private: true` workspaces — without it your packages are silently skipped),
  `gjsify workspace <name> <script>` for one (note: **no `run` keyword**).

```bash
gjsify foreach -A check                        # type-check everything
gjsify workspace curlew-cli build            # → app/dist/curlew.gjs.mjs
gjsify workspace curlew-cli test             # @gjsify/unit, on gjs AND node
gjsify run app/dist/curlew.gjs.mjs <command>
gjsify workspace curlew-cli test:whatsapp-network  # real WhatsApp, no account: up to the QR code
gjsify workspace curlew-cli test:signal-network    # real Signal, no account: up to the link address
```

**Run the suite with no session bus, and pin BOTH variables.** The `test` script sets
`DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` to `/nonexistent`, so the strict "session
unreachable" assertions in `backends.test.ts` hold on a desktop with a live session too. Pinning
only `DBUS_SESSION_BUS_ADDRESS` is not enough: the native stack (libgda, EDS) resolves the bus
from `XDG_RUNTIME_DIR` too.

Tests run on **both** runtimes. That dual run is the entire point of the pure/`*.gjs.ts` split —
if a change makes the Node run impossible, the change is in the wrong file.

A long-running FOREGROUND GJS process is killed by the werkstatt sandbox (Exit 144) — launch
the MCP server via `run_in_background` when driving it.

## Privacy — this repo is PUBLIC

- The local index holds mail headers **and plain-text bodies**. It lives at
  `$XDG_DATA_HOME/curlew/index.db` (or `postbote/`, see the fallback) (mode `0600`), **never** inside the repo. Same for
  attachments. `.gitignore` is the second line of defence; not writing there is the first.
- Test fixtures are **synthetic only**. Never commit a real message, address, or mailbox name.
- Credentials come from GOA per connection: never logged, never stored, never in a DTO.
- Chat sessions (Telegram's auth key and the api_id/api_hash it was created with; WhatsApp's
  Signal keys and device credentials; Matrix's access token and the device's crypto store — Olm
  account and every room key it received) and XMPP passwords are the secrets curlew stores:
  one file per account under `$XDG_DATA_HOME/curlew/secrets/<backend>/`
  (created 0600 in 0700), through `SecretStore` — never in the index, never logged, never in a
  DTO or MCP output. Its backup tier is `secret`; the index stays `derived`.
- **Delivery-only messages are `state`, not cache.** WhatsApp keeps no server archive: a
  message is gone from its servers once a device acknowledged it, so what `receiveDeliveries`
  writes is the only copy. With a `delivery-only` backend enabled the index is irreplaceable —
  never "fix" a problem by deleting and rebuilding it, and never ask the session for the next
  batch before the previous one is written. The WhatsApp auth state (Signal keys) is `secret`.
  A linked device that does not connect for ~14 days is logged out by WhatsApp.
  Baileys acknowledges a message BEFORE emitting it, so the receiver journals every event
  (fsync'ed, `secrets/whatsapp/<account>.journal`, 0600) before returning to Baileys, and replays
  a left-over journal first — never bypass it.
- **Signal is read-only through a gate too.** The only way to send a request is a libsignal chat
  connection's `fetch`, and it is handed out only behind `guardedFetch` (`packages/signal/src/
  guard.ts`): at link time `PUT /v1/devices/link` and `PUT /v2/keys?identity=aci`, during a sync
  nothing — the sync's `ChatHandle` has no `fetch` at all. Widen the allowlist only with a test
  naming the request. The one thing a sync sends is the envelope acknowledgement.
- **Signal acknowledges only what is on disk.** Per commit: decrypt → journal (fsync,
  `secrets/signal/<account>.journal`) → protocol store flush → acknowledge. Never acknowledge
  first (Signal deletes acknowledged envelopes), and never flush the protocol store on `close`
  (`store.discard()`): a saved ratchet step for an unacknowledged envelope turns its redelivery
  into a "duplicate" and loses the message. libsignal is never imported at module level — it is
  loaded on first use (`lib.ts`) so curlew starts where the addon does not. A plaintext that
  decrypts but that this build cannot map (a field a newer Signal added, a parser bug) joins that
  same flush in the account file's `signal.setaside` ledger — received, not lost, and counted in
  `DeliveryOutcome.setAside`; the ledger is bounded (`SET_ASIDE_LIMIT`) and a run that pushes an
  entry out says so. An accepted identity-key change is never silent: it becomes a
  `presentation: 'notice'` message in that contact's direct chat.
- **Matrix is read-only through a gate, not through good intentions.** Every request of
  matrix-js-sdk goes through `readOnlyFetch` (`packages/matrix/src/guard.ts`): GETs, login,
  the sync filter and the E2EE key protocol pass; a `/sync` without `set_presence=offline`
  (an omitted value means ONLINE) and everything else — receipts, typing, sends, joins — is
  refused and fails the sync. Widen the allowlist only with a test naming the request.
- **Matrix crypto state is saved before it is acknowledged.** The SDK's store checkpoints the
  crypto snapshot in `setSyncData`, which the sync loop awaits before the next `/sync` — the
  request that tells the server the to-device keys arrived. A save failure stops the run and
  is reported; it is never swallowed.
- **No secret in the config file** — it is `state`, plain text in every backup. `backends.<name>.
  settings` is for non-secret settings only; Telegram refuses an api_id/api_hash there.
- Server-side deletions: the mailbox engine sees them every flag pass; the chat engine on
  `sync --full-scan` (Telegram reports deletions only as live updates) and on every sync for a
  network that reports them in its history (XMPP retractions, Matrix redactions:
  `ChatHistoryPage.retracted`); the delivery engine as events (revoke, delete-for-me,
  clear/delete chat), applied in the batch they arrive in. Keep that pass working —
  a deleted message that stays MCP-readable is a privacy defect, not a staleness one.
- Only `curlew sync` and `curlew daemon` write to the index. A search never does — one
  mental model, and no surprise disk growth from a read. They are kept off the same delivery
  account by a **lease** (a row in the index, ADR 0002 §4) that BOTH take before connecting:
  the holder refreshes it and drops it on stop, a `sync` reports the holder and stands down, a
  daemon waits for it. User decisions (enabled
  backends, accepted terms, per-sender classification) go to
  `$XDG_CONFIG_HOME/curlew/config.json`, never the index, and overrides apply at read time.
- **Backends load only through the registry** (`app/src/core/backends/`), and only when the
  config enables them; a backend with a terms notice needs `--accept-terms` first. Built-in
  mail goes through it too — do not construct a backend anywhere else.

## Conventions

- **Parsing is pure.** Socket code does I/O and nothing else; every byte of grammar lives in
  `protocol` with unit tests. When you add an IMAP capability, the parser and its test come
  first, in `protocol` — not inline in the client.
- **No TypeScript parameter properties** (`constructor(private x: T)`). Node's
  `--experimental-strip-types` rejects them, which silently breaks the Node test run.
- **SQLite runs on libgda, not sqlite3** — gjsify's `node:sqlite` is a `Gda` wrapper, and it
  leaks through in five ways that WILL bite you. Read
  [`packages/store/AGENTS.md`](packages/store/AGENTS.md) before writing any SQL.
- **MCP tools are read-only or they do not register.** `applyReadOnlyGate` — from
  **`@gjsify/mcp`**, since 0.54.0; it was `app/src/frontends/mcp/runtime.ts`, which no longer
  exists — registers a tool only when `annotations.readOnlyHint === true`; a tool that omits the
  annotation is dropped. Do not loosen this to a name list.
  Two canaries prove it still bites (`tools/gate-canary.ts`, `CURLEW_MCP_GATE_CANARY=1`,
  asserted by `test:mcp`): one declares `readOnlyHint: false`, one carries NO annotations.
  The unannotated one is load-bearing — with only the first, the gate was rewritten to the
  fail-open spelling and the whole integration suite stayed GREEN. Never "simplify" them to one.
  **They matter MORE now, not less:** the gate is upstream code, so these are the only thing that
  would catch an upstream flip — and the failure it guards against (a mutating tool served
  quietly) is invisible on the wire until it is exploited. `test:mcp` needs no change for this.
- **A built curlew is relocatable only WITH its addon package.** Since gjsify 0.53 `--app gjs`
  no longer bakes the addon's absolute path: the bundle finds `@signalapp/libsignal-client` by
  package identity, in a `node_modules` reachable from the bundle. Libsignal loads on first use,
  so a bundle copied out WITHOUT one STARTS and dies at the first Signal command. `test:relocation`
  (`app/tests/integration/bundle-relocation.mjs`) copies the bundle out, stages only that one
  package beside it, and asserts the addon loads and no build path is in the bundle; its canary
  is `curlew addon-canary` (`CURLEW_CLI_ADDON_CANARY=1`), which prints typeofs — no server,
  no account, nothing of a user's. gjsify's `<bundle dir>/addons/` layout is not read yet
  (measured on 0.53.0).
- Conventional commits (`feat(imap): …`, `fix(store): …`), imperative, subject ≤ 50 chars.
  Run `gjsify foreach -A check` and the tests before committing. No `--no-verify`.
- This repo is a **submodule of werkstatt**: commit here on `main`, push, *then* bump the
  pointer in the parent. NEVER stage across that boundary in one commit.

## References

`refs/` holds 15 **read-only**, shallow reference repos (~330 MB with `.git`) for the
multi-protocol work decided in [ADR 0001](docs/adr/0001-multi-protocol-messenger.md). Never edit
under `refs/`; initialize only what the task needs
(`git submodule update --init --depth 1 refs/<name>`). CI does not check them out.
Read the code before claiming how a network or library behaves.

| Area | Repos | Read it for |
|---|---|---|
| Signal | `flare`, `presage`, `libsignal`, `signal-desktop` | GTK4 client (Flare via `flare-backend` → presage); Rust client lib; Neon/N-API `@signalapp/libsignal-client`; TS service layer in `ts/textsecure/` |
| Matrix | `fractal`, `matrix-rust-sdk`, `matrix-spec` | GTK4 client; SDK (uniffi FFI only, no Node binding); the spec |
| Telegram | `paper-plane`, `mtcute` | GTK4 client on TDLib (inactive since 2024-06); pure-TS MTProto |
| WhatsApp | `whatsmeow`, `baileys` | Go reference; TS library (needs `libsignal` + `whatsapp-rust-bridge`) |
| XMPP | `dino`, `xmpp.js` | GTK4 client with its own OMEMO (`plugins/omemo/`); TS client, no OMEMO |
| Mail UI | `convey`, `hylki` | GTK4 Geary fork (conversation cards, GOA); Rust/libadwaita mailbox + composer |

## Fix gjsify gaps at the core

gjsify is a first-party dependency, not vendored third-party code. If a capability is missing
or broken there, fix it in the `gjsify/gjsify` submodule with a test and let curlew pick it
up via a version bump — do not paper over it here.

A shim that is unavoidable meanwhile carries **one of two markers, and they mean opposite
things at bump time**:

- `// fixed upstream in gjsify: …` — the fix has LANDED. Delete the shim at the next bump.
- `// gjsify gap (unfixed, <PR>): …` — no upstream fix exists yet. The shim is **load-bearing**;
  leave it however redundant it looks.

**Neither marker is a substitute for measuring.** `download.ts` carried three of the second kind
against gjsify#1035; the fix arrived as #1039 instead, so the marker named a PR that was still
open while the behaviour it described had already changed. A bump re-measures the behaviour and
believes the result, not the note — that is a four-line probe, and it is how those three shims
came out in 0.32.0.

**The MCP runtime is upstream and that extraction is DONE.** `runtime.ts` was the extraction
candidate; at 0.54.0 it **is** `@gjsify/mcp`, and troedler's verbatim second copy is gone with it.
Nothing was re-implemented on the way in — same bodies, same signatures — so no client surface
moved: `tools/list`, a read-only `tools/call` and the error path are byte-identical against the
two bundles. `types.ts` stays for `mcpErrorFrom` alone, which is genuinely curlew's (it routes a
`GnomeError` through `describeUnavailable`; the package's generic one cannot know that). **The
tests did NOT move with the code:** `gate.test.ts` and the two canaries import the gate from the
package and keep pinning the fail-closed direction, because a gate this repo does not own is the
one case where "it was tested here once" stops being evidence.

## Licences

Apps (`app/`) are AGPL-3.0-or-later; the reusable packages are LGPL-3.0-or-later (own `LICENSE` +
`COPYING`). **`@curlew/signal` stays AGPL-3.0-or-later**: libsignal-client is AGPL-3.0-only and
parts are ported from Signal Desktop. So no LGPL package may depend on `@curlew/signal` — only
`app/` does. Decided in werkstatt's ADR on the licence split.
