# ADR 0008 — grants restrict agents, not the person

- **Status:** Accepted (2026-11-03)
- **Scope:** `app` (the grant check, `curlew send`, the MCP send tool, `curlew daemon`, the
  session-bus send service), `@curlew/xmpp` (follow presence). Amends
  [ADR 0004](0004-sending-and-writing-granted-per-capability.md) §2, §4 and §5.

## Context

[ADR 0004](0004-sending-and-writing-granted-per-capability.md) was written when curlew was an
account reader that an assistant (lotse) could be allowed to write through. Its §2 says the
person's accounts send only with a grant for that account, §4 makes every frontend ask the same
grant, and §5 follows an XMPP account only when an `xmpp.send` grant names it. A grant was the
only way an account became live.

Curlew is a messenger ([ADR 0001](0001-multi-protocol-messenger.md)). The GTK UI that comes next
sends from every account the person added, and a person who adds an account has already decided
that it is theirs. Asking them to grant themselves the right to use their own account is wrong
for the person and puts the decision in the wrong place: the thing worth guarding is what an
**agent** may do in their name.

Three places in the code still read the old rule:

- `curlew daemon` follows an XMPP account only when an `xmpp.send` grant names it, so a plain
  messenger user gets no live XMPP until they edit the config by hand. Matrix
  ([ADR 0007](0007-live-updates-over-the-session-bus.md) §5) already follows every enabled account.
- The daemon's session-bus send service re-checks the grant against the config it reads for each
  call (ADR 0004, amendment 2026-10-30, daemon send). The UI would be refused by its own daemon.
- `sendMessage` in the core checks the grant, so no frontend can send without one.

## Decision

### 1. An enabled account is fully usable

The person's own frontends need no grant for anything an enabled account can do.

- **The daemon follows every enabled account of a backend that has a follow mode.** XMPP joins
  Matrix, Signal and WhatsApp: the daemon lists the enabled backend's accounts and follows each,
  with the receive lease from ADR 0002 §4 as today. The `xmpp.send` requirement of ADR 0004 §5 is
  gone. `--account` still narrows a run to one account.
- **XMPP follow presence keeps the ADR 0004 §5 rules**: it lasts exactly as long as the daemon,
  the priority is negative, there is no status text, and the write log records the line when the
  account went available. What changes is only the condition: it is tied to the account being
  enabled and followed, not to a grant.
- **The person's frontends send from every enabled account without a grant.** Today that is the
  daemon's session-bus send service; later it is the GTK UI. The service serves them and checks no
  grant. The permit it hands to a backend's sender names the one address the request named, so a
  sender still re-checks what it was asked to send to, but nothing was decided about the person
  there.

### 2. Grants are agent access only

A grant (ADR 0004 §1, format unchanged) restricts **agents**. It applies per account and per
capability, fails closed, and is checked by the **agent frontends**:

- **MCP**: the gate of ADR 0004 §3 as it is, and the action behind it.
- **The CLI.** `curlew send` stays an agent frontend because any agent with a shell runs it —
  the reasoning of ADR 0004 §4 stands, and what changes is only that the person's other
  frontends are no longer in the same class.

The check is made **before** the core or the bus is reached. The core's `sendMessage` and the
daemon's send service do not check grants: they are the person's. An agent frontend calls one
function (`sendAsAgent`) that checks the grant for the exact `<account>/<address>` pair and then
calls the core, so the CLI and the MCP tool cannot drift.

**A message to the person's own account never needs a grant**, on any backend and from any
frontend: it reaches nobody else and speaks in nobody's name. What counts as "own" is each
backend's knowledge, not the account `identity` (which is a display name for Signal, WhatsApp and
Telegram) and not a switch in core: `SendBackend.isSelfAddress(account, to)` answers from what the
backend already stores about itself — Signal's own ACI, WhatsApp's own JID and LID with or without
device suffix, an XMPP bare JID with any resource, a mail address case-insensitively, Telegram's
own user id (Saved Messages), a Matrix user id. Only positive knowledge counts: a backend that
cannot tell (a Matrix room, a Signal phone number, a failing lookup, a missing method) answers
"not self" and the grant is required. The MCP tool is always registered, outside the grant gate,
and says in its description that without a grant it can only send to the person's own account.

A later UI page ("agent access") edits the grants. The page is not part of this record, and the
config format stays as ADR 0004 §1 specifies.

### 3. The honest limit

Under one Unix user the grants are a rule, not a wall. An agent with a shell can call the daemon's
D-Bus `Send` method directly — it is the person's own door and it checks nothing. The grants hold
against an agent that follows the rules, and against an agent that only has MCP; they do not hold
against a hostile process running as the same user. A hard boundary needs a sandbox (Flatpak with
a portal between the agent and the session bus), which is future work and not decided here.

### 4. Every write still leaves a line

ADR 0004 §7 is unchanged: each write appends a line to the write log after it happened, whoever
caused it. The `frontend` field already tells the callers apart.

### 5. Decryption and plaintext in the index — built (ADR 0009 step 4)

> **Amendment:** the daemon and `curlew sync` now decrypt every enabled XMPP account, `xmpp.omemo`
> is retired, and the grant watch and exit code 3 are gone.

The daemon decrypts OMEMO only for accounts an `xmpp.omemo` grant names (ADR 0006). A messenger
needs the text for every enabled account, so:

- **The index stores the decrypted text for every enabled account.** `xmpp.omemo` stops being what
  makes curlew decrypt.
- **An agent reading message BODIES needs a per-account read grant** in MCP and the CLI. Metadata
  tools that return no body are unchanged. This is a new capability (`messages.read`, target: an
  account id) and follows the grant rules of ADR 0004 §1 and the gate of §3.

> **Superseded in part by [ADR 0009](0009-agent-access-per-account-and-contact.md):** the read
> grant `messages.read` is replaced by the read mode of an agent-access rule (per account or per
> contact, `allow`, `ask` or `deny`). The rest of this section, decryption for every enabled
> account once the read gate is enforced, stands.

Both halves land together, in this order: the read grant first, because without it decrypting
every account would hand agents text they could not read before. Until then decryption follows
`xmpp.omemo` exactly as ADR 0006 specifies. That is the one reason the daemon still reads the
grants once at start and stops when they change (ADR 0004 §1): it applies to `xmpp.omemo` only,
and the watch goes away together with the grant.

## Consequences

- **A behaviour change for an existing user, deliberately:** with the XMPP backend enabled, the
  daemon follows every XMPP account curlew holds, including the ones that had no `xmpp.send`
  grant, and those accounts go available (negative priority) while it runs. A person who wants an
  account left alone disables the backend or runs the daemon with `--account`.
- The daemon no longer restarts on an edit of an `xmpp.send` grant, nor on any send grant: they
  change nothing it does. An `xmpp.omemo` edit still stops it (exit 3) until §5 is built.
- The send service on the bus no longer refuses for a missing grant. A refusal there now means
  what the backend says (a bad address, an unsupported image), never the person's configuration.
- `AGENTS.md` changes: "never sends without a grant" becomes "its send path is opened with a
  permit, and agent frontends check the grant before they reach it".
- The limit in §3 is part of the product's story, not a footnote: the README says "grants = agent
  access" and names the limit.

## Order of work

1. This record, and the amendment note in ADR 0004.
2. `curlew daemon` follows every enabled XMPP account.
3. The bus send service and the core `sendMessage` stop checking grants; `curlew send` and the MCP
   tool check them through `sendAsAgent`; the daemon's restart-on-grant-edit narrows to
   `xmpp.omemo`.
4. The read grant (`messages.read`) for body-returning tools in MCP and the CLI, then decryption
   for every enabled account, then the last grant watch is removed.
5. A GTK page "agent access" that edits the grants.
6. A sandbox (Flatpak/portal) between agents and the session bus.

## References

- [ADR 0004](0004-sending-and-writing-granted-per-capability.md) (grants; §2, §4 and §5 amended here)
- [ADR 0006](0006-omemo-end-to-end-encryption.md) (`xmpp.omemo`)
- [ADR 0002](0002-receiving-daemon.md) (the daemon and its lease)
- [ADR 0007](0007-live-updates-over-the-session-bus.md) (Matrix follows every enabled account)
