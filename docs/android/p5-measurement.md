# P5 measurement — what runs under NativeScript, per package

Measured 2026-11-16 against gjsify `packages/` (worktree `gjsify-p5`) and this repo. Companion to
[target-gap.md](target-gap.md), which covers the window layer. Scope of v1: IMAP only.

## Method and its limit

- Import surface: an esbuild bundle (`--platform=neutral`, `node:*`, `gi://*`, `@gjsify/*` external)
  of each package entry, with the external list read from the metafile. It proves **no hidden
  imports** beyond the ones below. It does **not** prove the code runs; nothing here was executed
  on a device or emulator.
- Platform support: the `runtimes.nativescript` slot in each gjsify `package.json`.

## Import surface

| Package (entry) | Imports |
|---|---|
| `@curlew/store` (`index.ts`) | `node:fs`, `node:os`, `node:path`, `node:sqlite` |
| `@curlew/imap` (`index.gjs.ts`) | `gi://GLib`, `gi://Gio` (`SocketClient`, streams), `@gjsify/system-accounts`, plus `node:*` via store |
| `@curlew/smtp` (only through the `@curlew/imap/send` entry since ADR 0018) | `nodemailer` (needs `node:net`, `node:tls`, `node:stream`, `node:crypto`) |
| app window layer | `gi://Gtk/Adw/Gdk/Gio/GLib/GObject/Pango/Graphene/GdkPixbuf/Xdp`, `node:fs/path/crypto/os/child_process/tty/zlib/url/stream/readline` |

## Package × platform

`runs` = no gjsify change expected; `needs X` = work required. "Android" assumes the real GObject
engine (ADR 0110); "iOS" assumes the pure-JS subset (ADR 0105 § 6).

| Package / module | gjsify slot (`nativescript`) | Android | iOS |
|---|---|---|---|
| `node:path` | `polyfill` | runs | runs |
| `node:fs` (sync API used by store) | `none` | needs a sync fs bridge; `@gjsify/native-fs-bridge` covers only `fs/promises` | same; NSFileManager side exists for promises only |
| `node:os` (`homedir`) | `none` | needs shim (`paths.ts` must stop assuming XDG; use app files dir) | same, app sandbox dir |
| `node:sqlite` (`db.ts`, `fts.ts`, `secret-store.ts`) | `none` | needs a SQLite binding with FTS5 + WAL | needs one, statically linked |
| `Gio.SocketClient` TLS (`transport.gjs.ts`) | n/a (real Gio) | **no TLS backend ships** (sysroot `2026.11.03`: `gio/modules/` empty, measured 2026-11-19); needs gjsify ADR 0117 stage 2 | needs real GI on iOS, which is unproven; a native opener behind `ByteStream` instead |
| `node:net` / `node:tls` (nodemailer) | `none` / `none` | needs a bridge | needs a bridge |
| `@gjsify/system-accounts` (GOA) | `none` | needs an Android account source; `noAccountStore` fallback already exists | same (Keychain) |
| window layer | `@gjsify/adwaita-nativescript` | gaps per target-gap.md | subset only; same gaps plus no real GI |

Nothing in the first four packages runs unchanged: every one touches a `none` slot. The only
no-change item is `node:path`.

## Findings

1. **`node:sqlite` is the first blocker and the cheapest to settle.** gjsify's `@gjsify/sqlite` is
   a TypeScript layer over `@gjsify/sqlite-native`, a Vala bridge to system libsqlite3 (a GJS
   prebuild). The comments in `@curlew/store` (`db.ts`, `paths.ts`) still describe it as a libgda
   wrapper with a mandatory `.db` suffix; that is out of date and should be re-checked before
   anyone relies on the suffix rule.
2. **Store needs sync file access and a data directory.** `secret-store.ts` uses `openSync(…,'wx',0o600)`,
   `chmodSync`, `rmSync`; `paths.ts` derives everything from `$XDG_*` and `homedir()`. Under
   NativeScript the path must come from the app sandbox, injected as a parameter.
3. **IMAP transport is Gio-only and implicit-TLS only.** `openTlsStream` rejects STARTTLS already.
   Whether `Gio.SocketClient.set_tls(true)` works on Android depends on a GIO TLS module in the
   bundle. Answered 2026-11-19: the pinned sysroot ships none, see
   [ADR 0018](../adr/0018-mail-transport-is-a-byte-stream-port.md).
4. **imap pulled in nodemailer.** `send.ts` imports `@curlew/smtp`. Done 2026-11-19: sending is the
   `@curlew/imap/send` entry, and the main entry no longer reaches the `node:net/tls` gap (ADR 0018 § 3).
5. **Accounts have a safe degraded path.** `@gjsify/system-accounts` is `native` for GJS only, but
   `noAccountStore` returns `unavailable` for every question. v1 can start with an in-app
   credentials form feeding the same `MailTarget` shape.

## iOS

No `dlopen`, no JIT, no runtime-loaded code. Consequences:

- **sqlite**: call the system `SQLite3` C functions through the NativeScript iOS bridge (NativeScript
  has no Node-API host; see gjsify ADR 0146, proposed). Confirm FTS5 is compiled into the system
  library (`probeFts5` in `db.ts` already checks this at open). A `.so` prebuild like
  `sqlite-native-*` cannot be used.
- **tls**: `tls-native` is a loadable module, so it is out. Options: static link, or a bridge to
  `Network.framework` / `NWConnection` behind the same stream interface. The second also gives the
  system trust store.
- **real GI** on iOS is "feasible, not proven" (ADR 0105 § 6): needs an iOS `#host` arm, a CFRunLoop
  pump and an answer on `g_module_open` for statically linked symbols. Until then iOS runs the
  subset and `Gio.SocketClient` does not exist, so the transport must be behind an interface with a
  non-Gio implementation.

## Recommended order

1. **AP5.1 — store.** Inject data/cache dirs (no `homedir`/XDG in the library), pick a SQLite path
   for Android, run `probeFts5` there. Smallest, self-contained, testable on an emulator.
2. **AP5.2 — transport.** Define a stream interface, keep the Gio implementation, and test it on
   Android first. Split send/nodemailer out of the entry. Add the iOS implementation (native
   bridge) only after the Android result.
3. **AP5.3 — accounts, then window layer.** Credentials form plus `noAccountStore`; then the
   target-gap.md items (enums, `Pango`, gestures, list views) in that document's order.

## Risks

- Android with no GIO TLS module: the Gio transport fails and a native TLS bridge is needed on
  both platforms anyway. Settled: Android has none today and gets Gio TLS through gjsify ADR 0117
  stage 2; the Java socket is only the fallback (ADR 0018 § 2).
- FTS5 availability differs between SQLite builds. A system library on Android is not reachable
  through the NDK, so a vendored build is likely there.
- iOS real GI is unproven and needs macOS CI; planning iOS against the subset keeps it off the path.
- `secret-store` relies on POSIX modes; sandbox storage is already private, but the encryption-key
  story (Keystore / Keychain) is undecided.
- This report is source analysis plus an import probe. Every "runs" above is still unrun.
