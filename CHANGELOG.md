# Changelog

## 0.2.0 — 2026-11-19

The first public release.

### What Curlew does

- One list for your mail and your chats from Telegram, Signal, WhatsApp, Matrix and XMPP. A person
  you reach on several messengers is one contact, with a default messenger you can change.
- Read and reply in the same window: text, pictures, videos, voice messages and files, sent and
  received the same way on every protocol, with reactions, edits, deletions and replies where the
  chat supports them.
- Mail threads that carry the `Chat-Version` marker show as email chats in the Delta Chat style.
  Sending the marker is a setting of each mail account and off by default.
- One search across chats and mail.
- A background service keeps receiving while the window is closed, so Signal and WhatsApp, which
  keep no server archive, miss nothing.
- A welcome screen walks through the protocols and accounts on the first start. Every setting is
  in the window; nothing needs the command line.
- AI assistants can use your messages over MCP only after you turn AI on, and then only per
  account and contact as you allow. AI and read receipts are off by default.
- English and German.

### Packages

- Linux: Flatpak, `.deb` and `.rpm` (x86_64). Mail accounts from GNOME Online Accounts work in
  every Linux package.
- macOS (Apple silicon and Intel): `.dmg` and `.zip`, signed and notarised. Preview, chat only.
- Windows (x64): `.msi` and `.zip`, not signed yet, so SmartScreen warns on first start. Preview,
  chat only.

### Known limits

- Signal, WhatsApp and XMPP groups can be read but not written to yet (#448); Telegram and Matrix
  groups can.
- Matrix sends to unencrypted rooms only; encrypted rooms are read.
- WhatsApp is an unofficial client and can get the account banned; Signal does not license
  third-party clients. Both show their terms before you enable them.
- Compatibility with Delta Chat itself is not confirmed against a live peer yet.
- Not on Flathub yet.

The development changelog up to this release:
[docs/project/history-before-0.2.0.md](https://github.com/JumpLink/curlew/blob/v0.2.0/docs/project/history-before-0.2.0.md).
