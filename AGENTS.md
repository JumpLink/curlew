# AGENTS.md — curlew

Operating guide for AI agents in **curlew**. Follows the [agents.md](https://agents.md/) convention;
the human overview is [README.md](README.md). This repo is a submodule of **werkstatt**, whose
[AGENTS.md](../../AGENTS.md) carries the broader workspace rules — this file is the curlew-specific
layer and wins where they differ.

## What this is

Mail (IMAP), contacts (CardDAV) and calendar (CalDAV) through GNOME Online Accounts, as a CLI and
MCP server. TypeScript monorepo running on GJS via gjsify. Details:
[`docs/project/overview.md`](docs/project/overview.md).

The index and MCP server are **read-only and fail-closed**. IMAP uses `BODY.PEEK` only; no flag
write, move, delete, or MCP write without a grant. **Grants restrict agents, not the person**
([ADR 0008](docs/adr/0008-grants-restrict-agents-not-the-person.md)): an enabled account is fully
usable by the person's frontends with no grant. **Agent sending is a granted `<backend>.send`
capability** ([ADR 0004](docs/adr/0004-sending-and-writing-granted-per-capability.md)); the check
lives once in `sendAsAgent` (`core/actions/send.ts`), called before the core or bus.

## Package layout — routing table

| Package | Details |
|---|---|
| `@curlew/protocol` | [package-layout.md](docs/project/package-layout.md) |
| `@curlew/gnome` | [package-layout.md → GOA/EDS](docs/project/package-layout.md#the-one-exception-curlewgnome) |
| `@curlew/imap`, `@curlew/smtp` | [package-layout.md](docs/project/package-layout.md) |
| `@curlew/store` | [packages/store/AGENTS.md](packages/store/AGENTS.md) |
| `@curlew/telegram`, `@curlew/whatsapp`, `@curlew/signal`, `@curlew/xmpp`, `@curlew/matrix` | [package-layout.md](docs/project/package-layout.md) |
| `curlew-cli` (`app/`) | [package-layout.md](docs/project/package-layout.md) |

**One rule:** `store` must never import a backend. Engines are driven through the ports in
`protocol` and injected by `app`. **`@curlew/whatsapp` is imported only by the app registry.**
`*.gjs.ts` files contain `gi://` imports; everything else must run on Node. Full rules:
[package-layout.md](docs/project/package-layout.md).

## Run / build / test

```bash
gjsify install                                 # NEVER npm install
gjsify foreach -A check                        # type-check everything
gjsify workspace curlew-cli build            # → app/dist/curlew.gjs.mjs
gjsify workspace curlew-cli test             # both runtimes, no session bus
gjsify run app/dist/curlew.gjs.mjs <command>
```

Details, pinning, bundle relocation and long-running process rules: [`docs/project/runtime.md`](docs/project/runtime.md).

## Privacy — this repo is public

Hard rules; per-backend details in [`docs/privacy/`](docs/privacy/).

- The index holds headers **and plain-text bodies** at `$XDG_DATA_HOME/curlew/index.db`, mode `0600`, **never inside the repo**. Attachments and secrets outside the repo too.
- Test fixtures are **synthetic only**.
- Credentials from GOA: never logged, stored, or in a DTO.
- Chat sessions are `secret`, one file per account in `SecretStore` — never in the index, logs,
  DTOs or MCP output.
- **Delivery-only messages are `state`, not cache** (WhatsApp, Signal). Never delete-and-rebuild
  the index to "fix" a problem; never ask for the next batch before the previous one is written.
- **Only `curlew sync` and `curlew daemon` write to the index.** A search never does.
- Backends load only through the registry (`app/src/core/backends/`) and only when enabled;
  backends with a terms notice need `--accept-terms` first.
- Server-side deletions must be applied in the batch they arrive in.

## Conventions

- **Parsing is pure.** Grammar lives in `protocol` with tests; socket code does I/O only.
- **No TypeScript parameter properties** (`constructor(private x: T)`).
- **SQLite runs on libgda, not sqlite3** — read [`packages/store/AGENTS.md`](packages/store/AGENTS.md)
  before writing any SQL.
- **MCP tools are read-only or gated by a grant.** Details and canaries:
  [`docs/conventions/mcp-gate.md`](docs/conventions/mcp-gate.md).
- **User-facing strings go through gettext** — `_`, `_n`, `_p`, `fmt` from `@curlew/protocol`.
  Never call `_()` at module level; never build plurals from `n === 1`.
  [`docs/i18n-status.md`](docs/i18n-status.md).
- Conventional commits, imperative, subject ≤ 50 chars. Run `gjsify foreach -A check` and tests
  before committing. No `--no-verify`.
- This repo is a **submodule of werkstatt**: commit here, push, then bump the parent pointer.
  NEVER stage across that boundary in one commit.

## Fix gjsify gaps at the core

gjsify is first-party; fix missing capabilities in the `gjsify/gjsify` submodule with a test and
bump curlew onto the new version. Unavoidable shims carry markers; details:
[`docs/conventions/gjsify.md`](docs/conventions/gjsify.md).

## References

`refs/` holds 15 read-only shallow reference repos. Never edit under `refs/`; initialize only what
the task needs. Catalogue: [`docs/references/index.md`](docs/references/index.md).

## Licences

Apps (`app/`) are AGPL-3.0-or-later; reusable packages are LGPL-3.0-or-later. **`@curlew/signal`
stays AGPL-3.0-or-later**: libsignal-client is AGPL-3.0-only and parts are ported from Signal
Desktop. No LGPL package may depend on `@curlew/signal` — only `app/` does.
