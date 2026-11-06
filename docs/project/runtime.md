# Build, run and test

## Dependencies

- **`gjsify install`** — NEVER `npm install`, it prunes gjsify deps.
- Node 24 to bootstrap (gjsify's install-backend prebuilds target 24; Fedora's 22 segfaults).
- All eight `@gjsify/*` packages are pinned to the **same exact version**. gjsify ships as one release train and a CLI ↔ libs skew produces silently broken bundles. Bump them together.
- `typescript` is pinned `^6.0.3`, **not** 7: `gjsify tsc` does not use this dependency, it runs a bundle with TypeScript 6.0.3 baked in. A local 7 would give a different diagnostic set than CI — green locally, red in CI.
- Use gjsify's own workspace feature, not npm's: `gjsify foreach -A <script>` (the `-A` includes `private: true` workspaces — without it your packages are silently skipped), `gjsify workspace <name> <script>` for one (note: **no `run` keyword**).

```bash
gjsify foreach -A check                        # type-check everything
gjsify workspace curlew-cli build            # → app/dist/curlew.gjs.mjs
gjsify workspace curlew-cli test             # @gjsify/unit, on gjs AND node
gjsify run app/dist/curlew.gjs.mjs <command>
gjsify workspace curlew-cli test:whatsapp-network  # real WhatsApp, no account: up to the QR code
gjsify workspace curlew-cli test:signal-network    # real Signal, no account: up to the link address
```

## Test environment

**Run the suite with no session bus, and pin BOTH variables.** The `test` script sets `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` to `/nonexistent`, so the strict "session unreachable" assertions in `backends.test.ts` hold on a desktop with a live session too. Pinning only `DBUS_SESSION_BUS_ADDRESS` is not enough: the native stack (libgda, EDS) resolves the bus from `XDG_RUNTIME_DIR` too.

Tests run on **both** runtimes. That dual run is the entire point of the pure/`*.gjs.ts` split — if a change makes the Node run impossible, the change is in the wrong file.

## Long-running processes

A long-running FOREGROUND GJS process is killed by the werkstatt sandbox (Exit 144) — launch the MCP server via `run_in_background` when driving it.

## Relocating a built bundle needs its addon package

**A built curlew is relocatable only WITH its addon package.** Since gjsify 0.53 `--app gjs`
no longer bakes the addon's absolute path: the bundle finds `@signalapp/libsignal-client` by
package identity, in a `node_modules` reachable from the bundle. Libsignal loads on first use,
so a bundle copied out WITHOUT one STARTS and dies at the first Signal command. `test:relocation`
(`app/tests/integration/bundle-relocation.mjs`) copies the bundle out, stages only that one
package beside it, and asserts the addon loads and no build path is in the bundle; its canary
is `curlew addon-canary` (`CURLEW_CLI_ADDON_CANARY=1`), which prints typeofs — no server,
no account, nothing of a user's. gjsify's `<bundle dir>/addons/` layout is not read yet
(measured on 0.53.0).
