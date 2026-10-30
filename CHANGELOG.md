# Changelog

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
- New read-only MCP tool `messaging_capabilities`: per protocol the maximum message length,
  formats, image support, maximum wait timeout and splitting.

### Fixed

- The `curlew-daemon.service` description names XMPP.

Calls that omit the new inputs behave exactly as in 0.1.0.

## 0.1.0

First release.
