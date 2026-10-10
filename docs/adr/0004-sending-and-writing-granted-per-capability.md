# ADR 0004 — sending and writing, granted per capability

- **Status:** Accepted (2026-10-10); amended 2026-10-10, see [Amendment](#amendment-2026-10-10)
- **Scope:** `@gjsify/mcp` (the gate), `app` (config, MCP server, `curlew send`, `curlew daemon`),
  `@curlew/xmpp`, `@curlew/protocol` (calendar port), `@curlew/gnome` (EDS calendar driver)

## Context

Curlew is read-only by design. IMAP is read with `BODY.PEEK`, the chat backends refuse every
request that would send, and the MCP server registers a tool only when it declares
`readOnlyHint: true` (`applyReadOnlyGate` from `@gjsify/mcp`). Sending exists as a library
capability, `@curlew/smtp`, with no MCP tool and no CLI command. `AGENTS.md` says write access
for agents needs its own decision. werkstatt ADR 0001 §5 says the same for mail.

This is that decision. kurier's assistant (kurier ADR 0002) needs three things Curlew cannot do
today:

- **send** messages from the assistant's own XMPP account to its person,
- **receive** the person's replies quickly, not only on the next `curlew sync`,
- **create** calendar entries, without a duplicate when the same source is handled twice.

The person's own accounts are a different matter. A message sent from them speaks in the
person's name, so they must not send unless the person decided so for that account.

## Decision

### 1. Capabilities, granted in the configuration

A write is named as a **capability**: `<area>.<verb>`, bound to one target.

| Capability | Target | Allows |
|---|---|---|
| `xmpp.send` | an account and one address | sending messages from that account to that address, and the presence it needs |
| `calendar.create` | a calendar | creating events in that calendar |

Later capabilities (`mail.send`, `whatsapp.send` per contact, `calendar.update`) follow the same
form and get their row when they are built.

**`xmpp.send`'s target is an `<account>/<address>` pair**, the same shape the planned per-contact
`whatsapp.send` will have: the grant says from where *and* to whom. A send to any other address
is refused, so a granted account is not a licence to write to the person's whole roster. Presence
is the one thing the pair's **account** alone grants, because a connection carries one presence
per account and not one per contact.

Grants are a list in `config.json` (`grants: [{ capability, target }]`). The file is `state`;
grants are no secret. **A grant names exactly one target**: a wildcard, an empty target or an
unknown capability is a configuration error at load. Without a grant, today's behaviour holds
unchanged.

**The grant set is read once, at process start.** A running `curlew daemon` refuses to continue
when it changes — it stops and says that the grants were edited and that the new set applies on
restart. So a revocation takes effect on a restart the person performs, never halfway through a
connection that is already open, and the error says exactly that rather than leaving them to
wonder whether the old grant is still live.

### 2. The person's accounts send only with a grant for that account

There is no account role such as "assistant". An account sends when a grant names it and does
not send when none does. The assistant's account is simply the one with a grant. A grant for one
account never covers another. Read receipts, chat markers and typing notices are not sent, not
even on a granted account.

### 3. The gate moves from read-only to granted, and stays fail-closed

The gate becomes two checks.

- **At registration:** a tool registers if `readOnlyHint === true`, or if it declares a
  capability and at least one grant for that capability exists. A tool without annotations is
  still dropped. A write tool without a granted capability is still dropped.
- **At each call:** the target the call names must be one the grant lists. Otherwise the call is
  refused with an error that names the capability, never by silently doing nothing.

The call check is not a line every write tool remembers to write. **The same wrapper that
registers a capability tool applies it**: the handler is reached only after the call's target
matched the grant set, so a tool cannot be registered with the check left out. A forgotten check
is the one failure that looks exactly like a working gate.

The registration check is generic and goes into `@gjsify/mcp`. gjsify gets a gate that takes
the app's grant set; it holds no capability names (no central registry, kurier `AGENTS.md`).
Capability names and the call check stay in Curlew.

The canaries grow from two to four: the existing two (a tool with `readOnlyHint: false`, a tool
with no annotations) stay; a write tool whose capability is **not** granted must be absent; a
write tool whose capability **is** granted must be present. The fourth one is the positive
control: without it, a gate that drops everything passes the first three.

The positive control declares a **test-only capability, `canary.write`**, which `grants` accepts
only while `CURLEW_MCP_GATE_CANARY=1` and rejects as an unknown capability otherwise — so the
grant that proves the gate opens cannot be written into a real configuration. Its handler
performs no write at all: it proves that the call reached it, and nothing else.

### 4. Every frontend asks the same grant

`curlew send --account <a> --to <address> <text>` and the MCP tool `send_message` check the same
grant. The CLI is no back door: an agent with a shell can run it too.

### 5. XMPP: sending and a follow mode

- `@curlew/xmpp` gets a send path that exists only on a handle opened with the grant, in the
  same pattern as Signal's `guardedFetch`: the sync handle has no way to send.
- A sent message is written to the index as the account's own message. MAM's echo is matched by
  origin id (XEP-0359), so it is not stored twice.
- **Follow mode:** `curlew daemon` keeps a live connection for a granted XMPP account and writes
  arriving messages into the index through the same path as MAM. After a reconnect MAM fills the
  gap. A live session needs an available presence, which is why presence falls under
  `xmpp.send`. An account without a grant is not followed, only synced. The lease from ADR 0002
  §4 also covers follow mode.
- **The presence lasts exactly as long as the daemon.** It is sent when follow mode connects and
  ends when it stops; there is no status text, and the priority is negative, so the account
  stays reachable without presenting itself as the person at a desk and without pulling their
  other clients' messages to curlew. The write log records the moment it went available — it is
  the one thing the account's contacts can see, so it is not an invisible write.

### 6. Calendar: an interface, EDS now, CalDAV later

- `@curlew/protocol` gets a `CalendarBackend` port: list calendars, list events, create an event.
  Following werkstatt ADR 0004 (GNOME is optional), the first driver is EDS in `@curlew/gnome`,
  and CalDAV follows as a second driver without changing callers.
- **A created event carries a source key**: `<source>:<id>`, for example the backend and message
  id it came from, stored as an iCalendar property (`X-CURLEW-SOURCE`). Creating an event with a
  key that already exists in the target calendar returns the existing event and creates nothing.
  That is a check and then a write, not one atomic operation: **two creates with the same source
  key running at the same time may both succeed**. The source key makes a repeated handling
  idempotent, not a concurrent one, and the thing that keeps the second create from starting is
  the ADR 0002 §4 lease the writer holds — not the key.
- Only creating is decided. Changing and deleting events need their own capability and their
  own row in the table above.

### 7. Every write leaves a line

Each granted write appends one line to a write log in Curlew's data directory: time,
capability, target, frontend and the id of what was created or sent. No message text. Tier
`state`, declared in `.werkstatt-state.json`.

The line is appended **after** the write, because it carries the id the write returned and a log
written first would claim a send that never left. A write whose log line cannot be appended is
reported as a failure of that call — the write happened and its record did not, which the person
has to hear. No log failure is swallowed.

## Consequences

- `AGENTS.md` changes on acceptance: "no MCP tool that sends" becomes "no write without a grant",
  `@curlew/xmpp`'s "NEVER sends" becomes "never sends without a grant", and the canary rule
  names four canaries.
- The mail rule of werkstatt ADR 0001 §5 is unchanged until someone needs `mail.send`. Then it
  follows this record and gets its row.
- The config format gains a field, and an older build does not merely ignore it. `parseConfig`
  today returns only `{backends, senders}` and `saveConfig` writes that object back
  (`parseConfig` and `saveConfig` in `app/src/core/config.ts`), so an old build that *saves* the config erases the grants
  — it fails closed on reading and destructively on writing. **Decision:** `parseConfig` carries
  unknown top-level keys through unchanged and `saveConfig` writes them back, so a build that
  does not know a key cannot drop it. The builds already released still drop them: a known,
  one-time risk, and the reason this goes in before `grants` is written anywhere.
- The gate change is a published `@gjsify/mcp` contract. It goes to gjsify first, with its
  own tests, and Curlew picks it up with the version bump.

## Order of work

1. `@gjsify/mcp`: gate with a grant set, tests in both directions (gjsify, released first).
2. Curlew: config pass-through of unknown keys first, then `grants` in the config, validation, the call check, four canaries in `test:mcp`.
3. `@curlew/xmpp`: guarded send handle; `curlew send` and the MCP tool.
4. `curlew daemon`: follow mode for granted XMPP accounts.
5. `CalendarBackend` port, EDS driver with source keys, `calendar.create` (for kurier's school
   dates task).

## References

- werkstatt ADR 0001 §5 (sending is a library capability), werkstatt ADR 0004 (GNOME is optional)
- kurier ADR 0002 (the assistant in continuous operation)
- ADR 0002 (the receiving daemon and its lease)

## Amendment (2026-10-10)

The decision above stands. One part of its scope moved out of curlew:

- **`calendar.create` and the `CalendarBackend` write path (§6, step 5 of the order of work) now
  belong to the separate app [reminder](https://github.com/JumpLink/reminder).** Curlew is a
  messenger: it keeps contacts and messaging writes (`xmpp.send` and the later `*.send`
  capabilities) and no longer writes calendar events. The capability is removed from the
  grants table and from `CAPABILITIES`; a config that still lists it is rejected as an unknown
  capability.
- The read-only `curlew calendar` command is slated to move to reminder as well.
