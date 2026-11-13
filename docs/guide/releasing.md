# Releasing and packaging


A tag `v*` pushed to the repo (`git tag v0.2.0 && git push --tags`) builds every
installable format and attaches them to a GitHub release:
[`.deb`/`.rpm`](../../.github/workflows/ci.yml) and [macOS (arm64 + x64) /
Windows (x64)](../../.github/workflows/ci.yml) packages, via
[`release.yml`](../../.github/workflows/release.yml). `workflow_dispatch` re-cuts
artifacts for an existing tag without moving it (`tag` + `publish` inputs).

**GOA and Evolution Data Server are Linux-only.** The macOS and Windows
packages still build and ship — they carry the same `curlew` CLI and MCP
server — but every account backend (mail, contacts, calendar; also the
chat/delivery backends that depend on `@curlew/gnome` for credentials)
reports itself unavailable on those two platforms, because the GObject-
Introspection libraries GOA/EDS need do not exist there. Today that is the
honest state of the macOS/Windows artifacts: a working binary with no
working account source. Closing that gap — a platform-native credential
and sync layer for macOS/Windows — is open work, not a bug in these
packages.

### Flatpak

CI builds a Flatpak (`ship-flatpak` artifact, `gjsify ship linux --target flatpak`). It is the
chat client: network, Wayland/X11 and nothing else, no `--talk-name=org.gnome.OnlineAccounts`
and no home access, so Curlew's index lives in `~/.var/app/eu.jumplink.curlew/`. Mail in the
sandbox is a chat transport with its own login, not a GOA account; contacts and calendar stay a
feature of the host build until a portal covers them. The rest of the app is brought to the
same-code-inside-and-outside-a-sandbox rule of gjsify ADR 0138 in the order set out in
[ADR 0011](../adr/0011-same-app-inside-and-outside-a-sandbox.md). The manifest is generated
from `gjsify.ship.flatpak` in `app/package.json`; Flathub itself needs offline npm sources
(`gjsify flatpak sources`) and is not wired yet.

### Embedding a Telegram api pair (packagers)

A distributor — for example a Flatpak manifest for a Telegram-only build, where
GOA is not needed — can embed *its own* `api_id`/`api_hash` (registered at
my.telegram.org under the distributor's name; per-distributor, never shared and
never committed to this repository) by setting both variables for the build:

```bash
CURLEW_TELEGRAM_EMBEDDED_API_ID=<id> CURLEW_TELEGRAM_EMBEDDED_API_HASH=<hash> \
  gjsify workspace curlew-cli build        # or build:node
```

`app/scripts/build-bundle.mjs` turns them into the compile-time constant
`__CURLEW_TELEGRAM_EMBEDDED__`; set only one, or malformed values, and the build
fails (values never printed). Unset — as in CI and dev builds — embeds nothing.
In a Flatpak manifest, put them in the `build-options.env` of the curlew module
(or inject them from the packager's secret store). The pair is readable by
anyone holding the bundle: Telegram treats it as an application identifier, not
a secret.

Local verification, mirroring what CI does on `fedora:44`:

```bash
gjsify workspace curlew-cli build:node   # darwin/win32 ship `dist/curlew.node.mjs`
gjsify install --os darwin --cpu arm64 --immutable
(cd app && gjsify ship darwin --arch arm64 --skip-build --target macos-app-zip)
gjsify install --os win32 --cpu x64 --immutable
(cd app && gjsify ship windows --arch x64 --skip-build --target windows-dir-zip,msi)
(cd app && gjsify ship linux --stage)   # needs gir1.2-*/typelib packages to assert .deb/.rpm fully
gjsify install   # back to the plain install afterwards
```

Unsigned on both macOS and Windows, by design (ADR 0024 § A13 in gjsify) —
a legitimate deliverable, not a placeholder. Where signing would attach, on
a runner that holds the identity:

- macOS — `gjsify ship darwin --arch <arch> --skip-build --target macos-app-zip --sign <identity>` (Developer ID; `--notarize <keychain-profile>` on top)
- Windows — same shape, `--sign <certificate thumbprint or PFX path>` reaching `signtool` (unverified upstream: no gjsify run has invoked it)

