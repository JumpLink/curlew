# curlew documentation

Agent- and contributor-facing docs for the curlew repo. The hard rules that load on every session live in [`AGENTS.md`](../AGENTS.md); these files hold the details, precedents and working notes.

## Project

- [`project/overview.md`](project/overview.md) — what curlew is, high-level architecture, origin
- [`project/package-layout.md`](project/package-layout.md) — package map, import rules, the `*.gjs.ts` split
- [`project/runtime.md`](project/runtime.md) — build, test and run commands; gjsify workspace rules
- [`project/rename-postbote.md`](project/rename-postbote.md) — why the old `postbote` name is still load-bearing

## Privacy and state

- [`privacy/data-tiers.md`](privacy/data-tiers.md) — what is `state`, `secret`, `derived`; where data lives
- [`privacy/whatsapp.md`](privacy/whatsapp.md) — delivery-only semantics, receive lease, journaling
- [`privacy/signal.md`](privacy/signal.md) — read-only gate, acknowledgement order, set-aside ledger
- [`privacy/matrix.md`](privacy/matrix.md) — `readOnlyFetch`, `sendFetch`, encrypted-room refusal

## Conventions

- [`conventions/mcp-gate.md`](conventions/mcp-gate.md) — read-only / granted-write MCP tool registration and canaries
- [`conventions/gjsify.md`](conventions/gjsify.md) — fixing gaps in gjsify instead of here, shim markers
- [`i18n-status.md`](i18n-status.md) — gettext usage, what is translated, module-level and plural traps

## Release

- [`release/flathub-checklist.md`](release/flathub-checklist.md) — Flathub readiness: finish args, metainfo, icons, open blockers

## Decisions

- [`adr/0016-the-window-stays-in-the-background.md`](adr/0016-the-window-stays-in-the-background.md) — hold and hide the window only where the person can get it back (proposed)

## Design and references

- [`design/ui.md`](design/ui.md) — window layout, role models, responsive rules
- [`design/contacts.md`](design/contacts.md) — merging one person across messengers
- [`design/replies.md`](design/replies.md) — quotes, replies, reactions, edit and delete
- [`design/thread-capabilities.md`](design/thread-capabilities.md) — what one thread may offer: reaction, edit, delete, reply
- [`design/rich-text.md`](design/rich-text.md) — links and inline Markdown in message bubbles
- [`design/signal-groups.md`](design/signal-groups.md) — fetching Signal group names from the Groups v2 service (proposal)
- [`references/index.md`](references/index.md) — the `refs/` shallow reference repos
