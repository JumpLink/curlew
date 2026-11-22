# AP5.1 probe: `node:sqlite` and the store on Android

Measured 2026-11-21 on the `NsGi_API_36` emulator (x86_64, debug build, gjsify plugins 0.64.54,
`@gjsify/sqlite` and `@gjsify/native-sqlite-bridge` 0.64.55 from npm) with the
[`app-android/`](../../app-android) shell. The `store` probe runs the real `@curlew/store` code
paths and logs one `CURLEW-PROBE` line, next to the [AP5.2 probes](ap52-probe.md).

## Result

| Step | Result |
|---|---|
| `openIndexDb(":memory:")` | pass; `:memory:` is supported, no cache-dir file needed |
| `migrate` (schema version 29) | pass, 28 tables |
| `probeFts5` (`unicode61 remove_diacritics 2`) | pass: FTS5 is available |
| `upsertAccount`, `upsertFolder`, `upsertMessages` (one message, body indexed) | pass, 1 row |
| `searchIndex({ query: "marz" })` on the body "…im März" | 1 hit (diacritics folded); a query with no match: 0 hits |

Log line: `CURLEW-PROBE PASS store store:0 68ms :memory: open, migrate tables=28, probeFts5, insert messages=1, fts hits=1 (marz) miss=0`.
All 6 probes pass, no FATAL or JS ERROR in logcat.

## File database

The `store-file` probe opens the real index in the app-private data dir: `knownFolders.documents()`
is `getFilesDir()`, and the file path comes from the store's own `storePaths()` (platform-free,
exported from `@curlew/store/index-db`; the shell passes its sandbox directories as `StoreDirs`).
It runs `openIndexDb` (WAL, `INDEX_BUSY_TIMEOUT_MS`), `migrate`, `probeFts5`, inserts one message,
closes, reopens, and checks the row, the FTS hit and `PRAGMA journal_mode`. The directory is removed afterwards.

Log line: `CURLEW-PROBE PASS store-file store-file:0 77ms app-private files dir open journal=wal, insert messages=1, reopen messages=1 tables=28 fts hits=1 journal=wal`.
7 of 7 probes pass on a first run and on a second cold start, no FATAL or JS ERROR in logcat.
`storePaths()` bundles `node:path`, so the shell now lists `@gjsify/path` as a dependency.

## How SQLite is wired

- `@gjsify/sqlite` supplies `node:sqlite`; on NativeScript it loads `@gjsify/native-sqlite-bridge`
  through its `native.android.ts` ([gjsify ADR 0147](https://github.com/gjsify/gjsify/blob/main/docs/adr/0147-node-sqlite-on-nativescript-binds-the-platform-sqlite.md)).
  Both are dependencies of the shell in `package.json`; the bundler needs no alias for them.
- The bridge binds `androidx.sqlite`'s `BundledSQLiteDriver`: SQLite with FTS5 from the AAR, not
  the OS image's. `data/Android/app.gradle` adds `androidx.sqlite:sqlite` and
  `androidx.sqlite:sqlite-bundled` 2.7.1 (2.6.2 is the floor).
- `data/Android/native-api-usage.json` whitelists the `androidx.sqlite` classes, because the shell
  sets `whitelist-plugins-usages`; without them `androidx.sqlite` is `undefined` at run time.
- `@curlew/store/index-db` is a narrow entry (open, migrate, FTS probe, upsert, search) so the
  shell does not pull the sync engines or the desktop paths, like `@curlew/imap/stream`.

## Gaps found

None in gjsify. The probe needed no shim.

## Still open

Login and the window layer (AP5.3) are unproven on Android. The shell does not yet derive
the real `StoreDirs` (data, cache, config) for the app; the probe only exercises the data directory.
