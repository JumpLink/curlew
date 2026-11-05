# ADR 0009 — agent access per account and contact

- **Status:** Accepted (2026-11-03). Steps 1–3 implemented (policy core, enforcement, daemon prompt).
- **Scope:** `app` (the policy core, config, MCP and CLI enforcement, `curlew daemon`, the
  session-bus prompt service, the GTK "agent access" page). Supersedes the read grant
  `messages.read` of [ADR 0008](0008-grants-restrict-agents-not-the-person.md) §5 and extends the
  grants of [ADR 0004](0004-sending-and-writing-granted-per-capability.md) §1.
- **Asked for by:** the person, 2026-11-03: "It should be possible to grant single accounts. For a
  single account it should be possible to allow read and write for all contacts. It should also be
  possible to allow access only for single contacts. It should be possible to be asked every time,
  and it should also be possible without asking. Similar to what we already built in Beifahrer."

## Context

ADR 0004 grants one capability per target, and every grant is a standing yes: `xmpp.send` for
`<account>/<address>` lets an agent send there until the person edits the file. ADR 0008 narrowed
grants to agents and decided, without building it, that an agent reading message bodies needs a
per-account read grant.

That is too coarse and too quiet for what the person asked for:

- A grant per backend capability cannot say "everything on this account" without listing every
  address, and cannot say "ask me" at all. The only answers are yes (a line in a file) and no.
- Read is one switch per account. The person wants an agent that may read one contact's
  conversation and nothing else of the same account.
- Every grant is silent. Some sends should be confirmed each time.

Beifahrer, the same author's browser agent, solved the same problem for sites: levels that fail
closed, explicit rules that win, temporary grants that live in memory, and a prompt with *Allow
once*, *For this session*, *Always* and *Deny*. Curlew takes those concepts and applies them to
accounts and contacts. It does not share code with it.

## Decision

### 1. Rules: a scope, a read mode and a write mode

A rule has a **scope** and two **modes**.

- **Scope:** an account (every contact of it), or one account/contact pair. The contact is a
  conversation address the backend uses, spelled exactly like today's send targets
  (`xmpp-abc123/friend@example.org`). No wildcards, no prefixes, no case folding, as in ADR 0004
  §1.
- **Modes:** one for **read** (message bodies, §7) and one for **write** (sending). Each is
  `allow`, `ask` or `deny`.
- **Write needs read.** A rule that sets write to `allow` or `ask` and read to `deny` is invalid
  and refused when the config is parsed, naming the rule. Where the modes come from different
  rules (§8), a write whose read resolves to `deny` is `deny`. A conversation an agent may write
  to is one it may read; a write-only rule would be a rule the person did not mean.

### 2. Resolution fails closed

For one request (account, contact, read or write):

1. **The person's own address is allowed** (§3).
2. **The most specific rule decides**: a contact rule beats an account rule, per kind. A rule
   that leaves a kind out says nothing about it, and the next rule up decides (§8).
3. **An explicit `deny` is final.** No temporary grant (§6) and no prompt answer widens it.
4. **With no rule**, the answer is `ask` when the person has *Ask for anything without a rule* on
   (the default), and `deny` when it is off.
5. **A temporary grant** for this session, for this scope and kind, turns `ask` into `allow`. It
   never overrides `deny`, and a rule that says `allow` needs no grant.
6. **`ask` resolves through the prompt** (§4). **If no prompt can be shown** — no daemon on the
   bus, no desktop session, a failing call — `ask` means `deny`, and the error tells the agent
   what the person can do: add a rule, or run the agent where curlew can ask.

Anything not understood (an unknown mode, a malformed rule) fails the config load, not the
request.

### 3. The person's own address

A message to the person's own address, and the reading of that conversation, is always allowed on
every backend. "Own" is what `SendBackend.isSelfAddress` answers (ADR 0008 §2): positive knowledge
only, a backend that cannot tell answers "not self" and the rules above apply.

### 4. Asking

The **daemon owns the prompt.** The MCP server and the CLI are separate processes; they ask over
the session bus through a new method (for example `RequestAccess(account, contact, kind, preview,
session)`), as the send service already travels there (ADR 0004, amendment 2026-10-30).

- **Surface.** Now a desktop notification with action buttons. Later a dialog in the GTK app
  (§Order of work).
- **Answers.**
  - *Allow once* covers this one request.
  - *For this agent session* covers the scope and kind until that session ends. It exists for MCP
    only: one MCP server process is one session. A CLI call is its own process and its own
    session, so it only ever gets *once*.
  - *Always* writes a persistent rule into the config for the scope and kind.
  - *Deny* refuses.
- **Refusal is the default.** No answer within **two minutes**, a dismissed notification and
  *Deny* all mean refused.
- **One prompt per scope and session at a time.** Concurrent requests for the same scope and kind
  from the same session wait on the same prompt; an answer covers every request waiting on it that
  needs no more than it granted.
- **No second question after a Deny.** The same session is not asked again for that scope until
  the session ends. A new session may ask.
- **A write prompt names the recipient and shows the start of the text.** "Ask every time" means
  the person confirms each message, and they cannot do that without seeing what it says. A read
  prompt names the account and contact.
- **The prompt shows the contact's name, looked up by the daemon.** A Signal ACI, a WhatsApp JID
  or a Matrix MXID is not recognisable, so the notification reads `Name (address)`. The daemon
  resolves the name from its own index (chat peer, else the address-book or mail participant
  that owns the address) and **never takes it from the request** — the requester is the agent,
  and a name it supplied could talk the person into allowing the wrong contact. The name is
  stripped of control characters and capped; no name or a failed lookup shows the address alone.
- **Privacy.** The prompt runs on the person's own desktop, so showing the preview there is fine.
  The preview never appears in a log, and the write log still holds no text (ADR 0004 §7).
- **The bus is the person's door.** A process that asks over the bus is what the §Honest limit
  describes: a hostile process under the same Unix user can answer its own question. The prompt
  protects against an agent that follows the rules.

### 5. Without asking

`allow` reads and sends without a prompt. That is the person's explicit choice per rule: the same
quiet write Beifahrer allows only after the person switches asking off. `ask` is what a rule says
until the person writes `allow`, and writing `allow` is the switch.

### 6. Temporary grants

*For this agent session* and, optionally, *for 1 hour* (a grant that ends by time as well). They
live in the daemon's memory, keyed by session, and never reach the config file. A daemon restart
ends all of them. There is no "forever" except *Always*, which writes a rule.

### 7. Metadata versus bodies

**Decided:** the read mode gates **message bodies and anything that returns message text**:
`include_bodies`, the wait-for-reply tool, mail body fetch and search over bodies, and any later
tool that returns text of a conversation. **Conversation lists, contact names and counts stay
readable** as they are today, because a prompt has to name the contact and an agent has to be
able to name what it asks for.

A possible later step is to gate metadata as well (who the person talks to is itself sensitive).
It is not decided here, and nothing in this record makes it harder.

### 8. The config

Rules live in `config.json` beside the old grants and are `state`, not secret.

```json
{
  "agentAccess": {
    "askWithoutRule": true,
    "rules": [
      { "account": "xmpp-abc123", "read": "allow", "write": "ask" },
      { "account": "xmpp-abc123", "contact": "friend@example.org", "read": "allow", "write": "allow" },
      { "account": "mail-def456", "read": "deny", "write": "deny" }
    ]
  }
}
```

- `askWithoutRule` defaults to `true`. A missing `agentAccess` is "ask, no rules".
- A rule without `read` or `write` says nothing about that kind: resolution falls through to the
  account rule, then to the no-rule default (§2.4). So a contact rule `{ "read": "allow" }` under
  an account rule `{ "write": "ask" }` reads quietly and asks before each send. The write-needs-read
  check runs on the resolved modes as well (§1). Two rules with the same scope are a configuration error.
- **Migration.** The old format stays readable: each `<backend>.send` grant
  (`<account>/<address>`) becomes a **contact rule** with `write: "allow"` and `read: "allow"`,
  in memory, whether or not `agentAccess` is present. A contact rule written out explicitly for
  the same pair wins over the migrated one. Nothing rewrites the person's file; the GTK page (§Order of
  work) writes the new format.
- **`xmpp.omemo` stayed as it was** until decryption runs for every enabled account (§9). It goes
  away together with the last grant watch (ADR 0008 §5).

### 9. Decryption

Decryption follows ADR 0008 §5 with the read mode in place of `messages.read`: once the read gate
is enforced, the daemon decrypts OMEMO for every enabled XMPP account and the index stores the
text. An agent reaches it only through the read mode.

### 10. The honest limit, and the write log

ADR 0008 §3 is unchanged. Under one Unix user the rules are a rule, not a wall: an agent with a
shell can call the daemon's `Send` directly. They hold against an agent that follows the rules and
against one that only has MCP. A hard boundary needs a sandbox, still future work.

Every write still logs (ADR 0004 §7), after it happened, with no text. The line now also records
**how the write was allowed**: by a rule, by *once*, by *session*, or by *self*. The person can
see from the log which sends were never asked about.

## Consequences

- **`messages.read` never exists.** ADR 0008 §5 named it; this record replaces it before it was
  built.
- **MCP and the CLI call one function** for both kinds, like `sendAsAgent` today, so the two
  frontends cannot drift. Read tools call it with the account and contact the request names; a
  tool that spans contacts (a search) is filtered or refused per contact, never answered whole.
- **Until the prompt exists, `ask` is `deny`.** That keeps each step shippable: after step 2 an
  agent has exactly the access the rules say, and a missing prompt can only refuse.
- **A new default for agents:** with no rule, bodies and sends are `ask`, which refuses until the
  prompt is built. Today a body is readable without any grant. Step 2 is therefore a behaviour
  change for existing agents and is called out in the release notes. Own-address conversations are
  unaffected.
- The person's frontends (the daemon send service, the GTK app) check none of this (ADR 0008 §1).
- A prompt can wait up to two minutes. The MCP server's tool timeout must allow for it, as
  Beifahrer's bridge does, so an agent does not give up while the person is reading.
- The rule format is small enough for the GTK page to edit without a second model.

## Order of work

1. A pure policy core (rules, resolution, temporary grants) with tests on gjs and node, plus
   config parse and the migration.
2. MCP and CLI enforce read and write through it, with `ask` treated as deny until the prompt
   exists.
3. The daemon prompt service: the bus method and the notification actions. Steps 2 and 3 are
   deployed together, so agents in use never spend a release refused where they would be asked.
4. Decryption for every enabled account, then removal of `xmpp.omemo` and the last grant watch.
   **Done:** `xmpp.omemo` is a retired capability (an old config still loads, the entry ignored),
   the daemon watches no grants and no longer exits with code 3.
5. A GTK "agent access" dialog (opened from the window's primary menu, see `docs/design/ui.md`) that edits the rules and later shows the prompt.
   **Done:** the page (`curlew window`). **Open:** the prompt as a dialog.
6. A sandbox (Flatpak/portal) between agents and the session bus.

## References

- [ADR 0004](0004-sending-and-writing-granted-per-capability.md) (grants, the gate, the write log)
- [ADR 0006](0006-omemo-end-to-end-encryption.md) (`xmpp.omemo`)
- [ADR 0007](0007-live-updates-over-the-session-bus.md) (the session bus)
- [ADR 0008](0008-grants-restrict-agents-not-the-person.md) (grants restrict agents; §5 superseded
  for the read grant)
- Prior art: Beifahrer's temporary access and asking on demand (concepts only, no shared code)
