# Changelog

## 0.2.0

### Added

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
