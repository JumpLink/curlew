# Package layout

The packages and the one rule that holds them together.

| Package | Contains | May import |
|---|---|---|
| `@curlew/protocol` | **Pure.** RFC grammar (IMAP lexer, ENVELOPE, FETCH, LIST, BODYSTRUCTURE, MIME, RFC 2047/2231, modified UTF-7), DTOs, errors, the plugin API: `MessageBackend` port + manifest, `BackendContext`, the `MailBackend` mailbox driver, the `ChatBackend` chat driver and the `SendBackend` send port (`SendPermit`, `MessageSender`) | nothing |
| `@curlew/gnome` | GOA + EDS: accounts, contacts, calendar, IMAP credentials | `protocol`, `gi://` |
| `@curlew/imap` | Gio TLS transport, IMAP client, folders, search, fetch, attachments, the mail `SendBackend` (SMTP through `@curlew/smtp`) | `protocol`, `gnome`, `smtp`, `gi://` |
| `@curlew/smtp` | Sending ONE message with attachments over SMTP on nodemailer (pinned exactly): message building, account validation, `verifyAccount`, `sendMessage`, `SmtpError`. No credential in a log, error or DTO; `security: 'none'` for loopback only. TLS and STARTTLS are tested against a loopback dummy server. The tool that may use it is the mail backend's granted sender, never this package itself | nodemailer, `node:*` — no `gi://`; imports no other package |
| `@curlew/store` | SQLite index, sync engines (mailbox + chat), conversations (threading, classification), secret store, XDG paths, file writes | `protocol`, `node:*` |
| `@curlew/telegram` | Telegram `chat` backend on mtcute (web build: WebSocket, WebCrypto, WASM), its session storage on `SecretStore`, the login, the `telegram.send` sender (plain text, ≤ 4096 chars), `connectLive` for the daemon's follow (mtcute updates are only a wake-up, on `TelegramClientHandle.live`, never on `TelegramApi`) | `protocol`, `store`, `@mtcute/*`, `node:*` — no `gi://` |
| `@curlew/whatsapp` | WhatsApp `delivery` backend on Baileys (unofficial protocol: WebSocket, WASM, libsignal), its auth state on `SecretStore`, the QR / pairing-code link, the `whatsapp.send` sender (plain text, ≤ 65536 UTF-8 bytes, 1:1 only) | `protocol`, `store`, `baileys`, `node:*` — no `gi://` |
| `@curlew/signal` | Signal `delivery` backend on `@signalapp/libsignal-client` (Rust behind N-API; on GJS through `@gjsify/napi`, loaded on first use), its protocol stores on `SecretStore`, the QR link as a linked device, the fail-closed request gate | `protocol`, `store`, `@signalapp/libsignal-client`, `qrcode-generator`, `node:*` — no `gi://` |
| `@curlew/xmpp` | XMPP `chat` backend on xmpp.js (composed by hand: domain-checked direct TLS, WebSocket, SCRAM), history from MAM only, the account file on `SecretStore`, the login. Sends no markers or messages for an agent without a grant; the daemon's follow presence is negative-priority (ADR 0004 §5) | `protocol`, `store`, `@xmpp/*`, `node:*` — no `gi://` |
| `@curlew/matrix` | Matrix `chat` backend on matrix-js-sdk + the Rust crypto as WASM (`@matrix-org/matrix-sdk-crypto-wasm`), its crypto store as an in-memory IndexedDB snapshotted into `SecretStore`, the password login, the `matrix.send` sender (plain text, ≤ 32000 UTF-8 bytes, refused for an encrypted room) | `protocol`, `store`, `matrix-js-sdk`, `@matrix-org/*`, `fake-indexeddb`, `node:*` — no `gi://` |
| `curlew-cli` (`app/`) | yargs CLI + MCP server, config file, backend registry | all of the above |

## The one rule

**`store` must never import a backend** (`imap`, `telegram`, `xmpp`, `matrix`, `signal`, …). The sync engines are driven through the driver ports declared in `protocol` (`MailBackend`, `ChatBackend`) and injected by `app`. That keeps `store` free of `gi://` and of any network library even transitively, which is the only reason the sync algorithms — the most intricate part of this project — can be unit-tested on Node against a fake backend and `:memory:`. If you find yourself wanting to import a backend from `store`, add a method to the port instead.

## WhatsApp is self-contained

**`@curlew/whatsapp` is imported by nothing but the app's registry** (`builtin.ts`) — no other package, no shared helper pulled out of it into `store` or `protocol`. WhatsApp is an unofficial protocol against WhatsApp's terms ([ADR 0001](../adr/0001-multi-protocol-messenger.md) §5): if a takedown or ban wave makes it necessary, the package must move to its own repository in one step. Anything it needs from the rest goes through the ports; duplicate a ten-line helper rather than share it.

## File naming and runtime split

**A file containing a `gi://` import is named `*.gjs.ts`.** Everything else is pure and must stay runnable on Node. Packages that need both ship a `package.json` `exports` map (`browser` → `index.gjs.ts`, `node`/`default` → a stub that throws `GnomeUnavailableError`), so `gi://` never enters a Node bundle.

## The one exception: `@curlew/gnome`

`@curlew/gnome` has no exports map and one `src/index.ts` for every runtime. The Node stub it used to have hid a distinction that mattered: GOA/EDS work on Node too, through `@gjsify/node-gi`, which resolves `gi://` with GJS semantics. GJS on Linux/GNOME is still the supported runtime; the Node path is groundwork for a macOS/Windows port. The `.gjs.ts` infix stays on its files, because they hold `gi://` imports.

- **GOA/EDS typelibs are OPTIONAL and load on first use, on EVERY runtime.** `libs.gjs.ts` wraps each namespace in `optionalNamespace` (`optional.ts`): the `gi://` import is a dynamic `import()` the bundler leaves alone, so a host without `libgoa`/`libedataserver` (macOS, a plain container) still starts, and the first call that needs one rejects with `GnomeUnavailableError`. `check()` reports it instead of throwing. Never add a top-level `gi://Goa|EDataServer|EBook|ECal` value import or a module-scope `Gio._promisify(...)` on those namespaces: either one resolves the typelib at load and takes the whole app down. `app/tests/unit/gnome/optional.test.ts` pins it on both runtimes.
- **One failure, one type.** A missing typelib is a `GnomeUnavailableError`; every other native failure (no session bus, a connect that never answers) leaves the public entry points as a `GnomeError` naming the call, with the GError domain and code set (`errors.ts`). A raw GJS `GLib.Error` is a boxed GObject, not an `Error`, and JSON-serialises to `{}`.
- **The Node bundle has a real dependency the source never imports**: `@gjsify/node-gi`. Its `gi://` shim stays an external import in the output, which is why it is a `dependencies` entry of `@curlew/gnome`.

`@curlew/imap` keeps its split: its Gio TLS transport needs GJS. Do not assume the move generalizes.
