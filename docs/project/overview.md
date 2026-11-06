# Project overview

Mail (IMAP), contacts (CardDAV) and calendar (CalDAV) through **GNOME Online Accounts**, as a CLI and an MCP server. A TypeScript monorepo that **runs on GJS via gjsify** (not Node), following the buchhaltung/leitstand pattern: pure-TS `packages/*` + one `app` workspace that carries the gjsify toolchain and picks a frontend at the yargs entrypoint.

curlew was formerly called `postbote`; see [`rename-postbote.md`](rename-postbote.md) for why the old name is still load-bearing in file paths, environment variables and on-disk namespaces.

The code came out of `buchhaltung/packages/gnome`; the git history there is the deeper record.

## Read-only, fail-closed, grant-gated

The local index and the MCP server are read-only and fail-closed.

- IMAP is spoken with `BODY.PEEK` only, so `\Seen` is never set; there is no flag write, no move, no delete, and no MCP tool that writes without a grant.
- **Grants are agent access, not a lock on the person** ([ADR 0008](../adr/0008-grants-restrict-agents-not-the-person.md)): an enabled account is fully usable by the person's frontends (the daemon's bus send service, later the UI) with no grant.
- **An agent's sending is a granted capability per backend**, `<backend>.send` with an `<account>/<address>` target — `xmpp.send`, `mail.send`, `telegram.send`, `matrix.send`, `signal.send` and `whatsapp.send` exist today — off by default and refused for every pair a grant does not name ([ADR 0004](../adr/0004-sending-and-writing-granted-per-capability.md), amended 2026-10-30).
- The check lives once, in `sendAsAgent` (`core/actions/send.ts`), which the CLI and MCP call BEFORE the core or the bus — `sendMessage` and the daemon's send handler check none; a message to the account's own address needs no grant.
- A backend's send path exists only on a handle opened with a permit (`SendBackend.openSender`), and the sync handle cannot send (Telegram: `sendText` is on the full client handle only, never on `TelegramApi`/`ChatSession`; Matrix: the permit opens a second `fetch` that passes exactly one endpoint, `PUT …/rooms/{roomId}/send/m.room.message/{txnId}`, while the sync handle's `readOnlyFetch` refuses every write). Every agent frontend, CLI included, asks the same grant.

Honest limit: under one Unix user an agent with a shell can call the daemon's D-Bus `Send` itself.
