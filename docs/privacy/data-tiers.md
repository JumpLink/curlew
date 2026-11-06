# Privacy and data tiers

This repo is **public**. The local index holds mail headers **and plain-text bodies**.

## Where data lives

Nothing is ever written inside the repository. `.gitignore` is the second line of defence; not writing there is the first.

- `$XDG_DATA_HOME/curlew/index.db` (or `postbote/`; see [`rename-postbote.md`](../project/rename-postbote.md)) — mode `0600`, re-applied on every open.
- Attachments to `$XDG_DOWNLOAD_DIR`, else `$XDG_DATA_HOME/curlew/attachments`, dir mode `0700`.
- Backend secrets (chat sessions) in `SecretStore` files under `$XDG_DATA_HOME/curlew/secrets/`, 0600 in 0700, TEXT only (bytes as base64).
- Overridable only through `CURLEW_DATA_DIR` / `CURLEW_DB_PATH` / `CURLEW_ATTACHMENTS_DIR` / `CURLEW_SECRETS_DIR` (and the `POSTBOTE_*` fallback; see [`rename-postbote.md`](../project/rename-postbote.md)).

## Tiers

| Tier | What | Backup rule |
|---|---|---|
| `state` | The index, config file, delivery-only message content | Irreplaceable; included in backups |
| `secret` | Chat sessions, credentials, crypto stores | Never in the clear, never in git, never in MCP output |
| `derived` | Rebuildable data, server-archive messages | Can be regenerated |

## Hard rules

- **Test fixtures are synthetic only.** Never commit a real message, address, or mailbox name.
- **Credentials come from GOA per connection:** never logged, never stored, never in a DTO.
- **Chat sessions** (Telegram's auth key and the api_id/api_hash it was created with; WhatsApp's Signal keys and device credentials; Matrix's access token and the device's crypto store — Olm account and every room key it received) and XMPP passwords are the secrets curlew stores: one file per account, through `SecretStore` — never in the index, never logged, never in a DTO or MCP output.
- **No secret in the config file** — it is `state`, plain text in every backup. `backends.<name>.settings` is for non-secret settings only; Telegram refuses an api_id/api_hash there.
- **Only `curlew sync` and `curlew daemon` write to the index.** A search never does. They are kept off the same delivery account by a **lease** (a row in the index, [ADR 0002](../adr/0002-receiving-daemon.md) §4) that BOTH take before connecting: the holder refreshes it and drops it on stop, a `sync` reports the holder and stands down, a daemon waits for it.
- User decisions (enabled backends, accepted terms, per-sender classification) go to `$XDG_CONFIG_HOME/curlew/config.json`, never the index, and overrides apply at read time.
- **Backends load only through the registry** (`app/src/core/backends/`), and only when the config enables them; a backend with a terms notice needs `--accept-terms` first. Built-in mail goes through it too — do not construct a backend anywhere else.

## Server-side deletions

The mailbox engine sees them every flag pass; the chat engine on `sync --full-scan` (Telegram reports deletions only as live updates) and on every sync for a network that reports them in its history (XMPP retractions, Matrix redactions: `ChatHistoryPage.retracted`); the delivery engine as events (revoke, delete-for-me, clear/delete chat), applied in the batch they arrive in. Keep that pass working — a deleted message that stays MCP-readable is a privacy defect, not a staleness one.

Below the window a full scan re-read, a backend that can ask the network about single ids (`ChatSession.probeRetracted`, Telegram's `getMessages`) is asked about a bounded slice of the stored ids, rotating over the chat across runs ([ADR 0004](../adr/0004-deletions-below-the-window-are-probed-by-id.md)) — the bound and the cursor are what keep it off FLOOD_WAIT, so do not drop either. A short FLOOD_WAIT that does arrive is slept out (up to 60 s, `FLOOD_SLEEP_THRESHOLD_MS`); only a longer one stops the run (#72).

## Per-backend notes

- [WhatsApp](whatsapp.md)
- [Signal](signal.md)
- [Matrix](matrix.md)
