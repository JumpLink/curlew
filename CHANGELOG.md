# Changelog

## Unreleased

### Changed

- `curlew window`: the filter chips are pills that fill with the accent colour while on, and the
  protocol badge sits on a solid circle at the avatar's rim, so it is legible and no longer covers
  the initials. gjsify 0.64.19.

### Added

- `packaging:install` (new `scripts/install-packaging.sh`): installs the desktop entry, the
  hicolor icons and the AppStream metadata into `~/.local/share` — honouring `XDG_DATA_HOME`,
  `PREFIX` and `DESTDIR` — and refreshes the desktop and icon caches, so GNOME Shell lists
  Curlew, matches the window to its launcher and finds the window icon. The desktop file now
  sets `StartupWMClass=eu.jumplink.curlew`. The script writes no `curlew` wrapper and no
  systemd unit; that wiring stays with `curlew setup` and the machine.

- Mail attachments: `send_message` takes `attachments` (absolute paths) and `curlew send` a
  repeatable `--attach <path>`. Mail only; other backends and the daemon send path refuse
  them. Limits: 10 files, 20 MB each, 25 MB total. The permission prompt lists the file
  names and the write log records names and sizes, never content.

- `curlew window`: the first GTK 4 / libadwaita window. A split view whose sidebar is one
  read-only list of every conversation in the index (People and Groups, protocol and account
  chips, search, protocol badge, grey unread count) and which collapses to one pane at 720 sp.
  *Agent access* opens from the primary menu as a dialog that lists and edits the `agentAccess`
  rules — per account and contact, read and write as allow, ask or deny, add and remove a rule,
  and the `askWithoutRule` switch. A rule that comes from an old send grant is shown as such.
  Only the explicit command opens a window. A desktop file and AppStream metadata
  (`eu.jumplink.curlew`) ship with it; the icon is still open. Rules: `docs/design/ui.md`.

## 0.2.0

### Added

- `telegram.send`: send one plain-text message (≤ 4096 characters) to a granted Telegram chat with
  `curlew send` or `send_message`. `messaging_capabilities` lists Telegram.
- `matrix.send`: send one plain-text message (≤ 32000 UTF-8 bytes) to a granted Matrix room with
  `curlew send` or `send_message`. The target is `<account>/<room id>`, the room id as
  `conversations_list` shows it. An end-to-end encrypted room is refused — curlew decrypts but
  does not encrypt, and it sends no cleartext there. `messaging_capabilities` lists Matrix.
- `whatsapp.send`: send one plain-text message (≤ 65536 UTF-8 bytes) to a granted 1:1 WhatsApp
  chat with `curlew send` or `send_message`. The target is `<account>/<chat jid>`, the JID as
  `conversations_list` shows it; a bare phone number, a device address, a group and a status
  update are refused. A send takes the receive lease, so it is refused while the daemon holds
  the account — WhatsApp allows one connection per linked device.
  `messaging_capabilities` lists WhatsApp.
- `send_message` takes an optional `format` (`plain` by default, or `markdown`). Markdown is
  rendered as XEP-0393 for XMPP, and texts over 7000 characters are split into several
  messages. The answer then carries `parts` and `originIds`.
- `xmpp_wait_reply` takes an optional `strip_quotes` (default `false`) that removes quoted
  reply lines from the message text.
- Agent access is enforced (ADR 0009): every agent send and every read of a message body is
  checked against `agentAccess` per account and contact — in the MCP tools and in the CLI's
  agent commands. On `ask`, `curlew daemon` shows a notification (*Allow once*, *For this
  session*, *Always*, *Deny*); no answer in 2 minutes, a dismissal or *Deny* refuses. New bus
  method `RequestAccess` on `eu.jumplink.curlew.Daemon1`. Searches that span contacts return only
  the hits you allowed and report `withheld`.
- The access notification names the contact — `Name (address)` — for Signal, WhatsApp, Matrix
  and mail, where the address alone is an ID nobody recognises. The daemon looks the name up in
  its own index; a name in the request is ignored, and none known shows the address as before.
- New read-only MCP tool `messaging_capabilities`: per protocol the maximum message length,
  formats, image support, maximum wait timeout and splitting.

### Changed

- Grants restrict agents, not the person (ADR 0008). The daemon follows every enabled XMPP
  account without an `xmpp.send` grant, and the daemon's bus send service checks no grant.
  `curlew send` and `send_message` still need a grant, except a message to the account itself,
  which every backend recognises in its own spellings (Signal ACI, WhatsApp JID and LID, XMPP
  JID with any resource, mail address, Telegram Saved Messages, Matrix user id) and which needs
  no grant. `send_message` is now always listed.

- **Agents now need access to read message bodies.** With no rule a body is `ask`, so an agent
  that read freely before is asked per contact (or refused when no daemon runs). The old
  `<backend>.send` grants keep working as rules allowing read and write for that pair. A grant
  for one backend's send now also covers the same account and address of another backend,
  because rules are per account. Your own CLI and the GTK app are not affected.

- OMEMO is decrypted for every enabled XMPP account (ADR 0009 §9); the `xmpp.omemo` grant is
  gone and an old config that lists it still loads, the entry ignored. The daemon no longer
  watches the config for grant edits, so it never exits with code 3 to restart.

### Fixed

- The `curlew-daemon.service` description names XMPP.

Calls that omit the new inputs behave exactly as in 0.1.0.

## 0.1.0

First release.
