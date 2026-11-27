# curlew documentation

Agent- and contributor-facing docs for the curlew repo. The hard rules that load on every session live in [`AGENTS.md`](../AGENTS.md); these files hold the details, precedents and working notes.

## Project

- [`project/overview.md`](project/overview.md) — what curlew is, high-level architecture, origin
- [`project/package-layout.md`](project/package-layout.md) — package map, import rules, the `*.gjs.ts` split
- [`project/runtime.md`](project/runtime.md) — build, test and run commands; gjsify workspace rules
- [`project/responsiveness.md`](project/responsiveness.md) — the 50 ms main-loop budget, `dev/perf.sh`, the CI gate, why the list is built the way it is
- [`project/history-before-0.2.0.md`](project/history-before-0.2.0.md) — the development changelog up to the first release

## Android

- [`android/p5-measurement.md`](android/p5-measurement.md) — what runs under NativeScript, per package
- [`android/target-gap.md`](android/target-gap.md) — measured gaps of the NativeScript target (widgets, enums, namespaces), the measuring command

## Guide

- [`guide/protocols.md`](guide/protocols.md) — per-protocol setup, terms and behaviour, sending grants, end-to-end encryption
- [`guide/cli.md`](guide/cli.md) — requirements, install, `curlew setup`, the command line
- [`guide/daemon.md`](guide/daemon.md) — the receiving daemon and its systemd unit
- [`guide/mcp-and-data.md`](guide/mcp-and-data.md) — the MCP server, agent access, where your data lives, demo mode
- [`guide/releasing.md`](guide/releasing.md) — release tags, Flatpak, packagers

## Privacy and state

- [`privacy/data-tiers.md`](privacy/data-tiers.md) — what is `state`, `secret`, `derived`; where data lives
- [`privacy/whatsapp.md`](privacy/whatsapp.md) — delivery-only semantics, receive lease, journaling
- [`privacy/signal.md`](privacy/signal.md) — read-only gate, acknowledgement order, set-aside ledger
- [`privacy/matrix.md`](privacy/matrix.md) — `readOnlyFetch`, `sendFetch`, encrypted-room refusal

## Conventions

- [`conventions/mcp-gate.md`](conventions/mcp-gate.md) — read-only / granted-write MCP tool registration and canaries
- [`conventions/gjsify.md`](conventions/gjsify.md) — fixing gaps in gjsify instead of here, shim markers
- [`i18n-status.md`](i18n-status.md) — translation status, the check commands and the LC_ALL=C / LANGUAGE=de counter-check, gettext usage, module-level and plural traps

## Release

- [`release/flathub-checklist.md`](release/flathub-checklist.md) — Flathub readiness: finish args, metainfo, icons, open blockers
- [`release/run-through.md`](release/run-through.md) — the supervised real-window and real-Flatpak run before a release

## Decisions

- [`adr/0001-multi-protocol-messenger.md`](adr/0001-multi-protocol-messenger.md) — curlew is a multi-protocol messenger; mail is one backend (accepted)
- [`adr/0002-receiving-daemon.md`](adr/0002-receiving-daemon.md) — the receiving daemon and the lease that keeps two of them apart (accepted)
- [`adr/0003-degraded-link-state-is-user-visible.md`](adr/0003-degraded-link-state-is-user-visible.md) — a degraded linked-device state is stated, not summarised (accepted)
- [`adr/0004-deletions-below-the-window-are-probed-by-id.md`](adr/0004-deletions-below-the-window-are-probed-by-id.md) — deletions below the re-read window are probed by id (accepted)
- [`adr/0004-sending-and-writing-granted-per-capability.md`](adr/0004-sending-and-writing-granted-per-capability.md) — sending and writing, granted per capability (accepted)
- [`adr/0005-calendars-and-contacts-without-goa-eds.md`](adr/0005-calendars-and-contacts-without-goa-eds.md) — calendars and contacts without GOA/EDS (accepted)
- [`adr/0006-omemo-end-to-end-encryption.md`](adr/0006-omemo-end-to-end-encryption.md) — OMEMO end-to-end encryption for XMPP (accepted)
- [`adr/0007-live-updates-over-the-session-bus.md`](adr/0007-live-updates-over-the-session-bus.md) — change journal in the index, wake-up on the session bus (accepted)
- [`adr/0008-grants-restrict-agents-not-the-person.md`](adr/0008-grants-restrict-agents-not-the-person.md) — grants restrict agents, not the person (accepted)
- [`adr/0009-agent-access-per-account-and-contact.md`](adr/0009-agent-access-per-account-and-contact.md) — agent access per account and contact (accepted)
- [`adr/0010-attachments-across-protocols.md`](adr/0010-attachments-across-protocols.md) — attachments across protocols (accepted)
- [`adr/0011-same-app-inside-and-outside-a-sandbox.md`](adr/0011-same-app-inside-and-outside-a-sandbox.md) — one app, inside and outside a sandbox (accepted)
- [`adr/0012-voice-note-transcripts.md`](adr/0012-voice-note-transcripts.md) — transcripts of received voice notes (proposed)
- [`adr/0013-appearance.md`](adr/0013-appearance.md) — accent, chat background, floating bars (proposed)
- [`adr/0014-delta-chat-is-a-protocol.md`](adr/0014-delta-chat-is-a-protocol.md) — Delta Chat is a protocol, opt-in per mail account (proposed)
- [`adr/0015-capabilities-per-thread.md`](adr/0015-capabilities-per-thread.md) — capabilities are per thread and person (proposed)
- [`adr/0016-the-window-stays-in-the-background.md`](adr/0016-the-window-stays-in-the-background.md) — hold and hide the window only where the person can get it back (proposed)
- [`adr/0017-media-thumbnails-at-sync.md`](adr/0017-media-thumbnails-at-sync.md) — store the preview the network ships with the message, so a big video is not a dark box (accepted)
- [`adr/0018-mail-transport-is-a-byte-stream-port.md`](adr/0018-mail-transport-is-a-byte-stream-port.md) — the IMAP client talks to a byte-stream port, sending is its own entry, Android waits for Gio TLS (proposed)
- [`adr/0020-mute-and-favourites-sync-with-the-protocol.md`](adr/0020-mute-and-favourites-sync-with-the-protocol.md) — mute and favourites are local first and sync with the protocol where it has them

## Design and references

- [`design/ui.md`](design/ui.md) — window layout, role models, responsive rules
- [`design/contacts.md`](design/contacts.md) — merging one person across messengers
- [`design/replies.md`](design/replies.md) — quotes, replies, reactions, edit and delete
- [`design/thread-capabilities.md`](design/thread-capabilities.md) — what one thread may offer: reaction, edit, delete, reply
- [`design/rich-text.md`](design/rich-text.md) — links and inline Markdown in message bubbles
- [`design/emoji-picker.md`](design/emoji-picker.md) — the virtualised emoji popover and where its data comes from
- [`design/signal-groups.md`](design/signal-groups.md) — fetching Signal group names from the Groups v2 service (proposal)
- [`references/index.md`](references/index.md) — the `refs/` shallow reference repos
