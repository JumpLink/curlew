# ADR 0015 — capabilities are per thread and person, not per backend

- **Status:** Proposed (2026-11-12). Decided by Pascal in chat; the choices below are the agreed shape.
- **Scope:** `@curlew/protocol` (capability types, a per-thread query), the backends that can answer
  it (`@curlew/imap`, `@curlew/xmpp`, the chat backends), `app` (window actions), and the design
  note `docs/design/contacts.md`.
- **Builds on:** [ADR 0001](0001-multi-protocol-messenger.md) (backends behind one port),
  [ADR 0014](0014-delta-chat-is-a-protocol.md) (mail as Delta Chat only for marked peers).

## Context

What a backend can do is a static promise today:

- `BackendCapabilities` (`packages/protocol/src/messenger.ts:39`) is read from the manifest:
  "every field is a promise the frontends rely on to show or hide a feature".
- `SenderFeatures` (`packages/protocol/src/backend.ts:813`) is the same per sender handle, still one
  answer for the whole account.

That fits Signal or Telegram. It does not fit mail, where reactions, edits and deletes exist only
if the peer's client understands them (ADR 0014), nor XMPP, where it depends on the contact's
client. XMPP already asks per JID: `XmppApi.features(jid)` (`packages/xmpp/src/client.ts:420`,
exposed read-only at `:630`) runs a disco query. Matrix and others will want the same question for
room or user versions.

Cross-protocol routing ([contacts design](../design/contacts.md), rule 1) states that a message
never switches protocol silently. That is right for a message being sent, but the rule is worded
for anything, and it says nothing about actions that address an existing message.

## Decision

### 1. Capabilities are asked per thread and person

A capability set belongs to a **thread** (one conversation with one peer or room on one backend),
not to the backend. The static manifest value stays as the **upper bound** (what the backend can
ever do); the per-thread answer narrows it. XMPP's per-JID query is the model: generalise it to a
port method every backend may implement, with the manifest as the default answer when it does not.

### 2. The UI offers an action only if the thread's protocol supports it

No greyed-out entries, no action that fails later because the network cannot do it. The reaction row,
edit, delete for everyone, and the read receipt appear if and only if the open thread's capability
set contains them. This restates the existing "never offer an action a chat cannot do" rule at its
real granularity.

### 3. Merged contacts: the default chat protocol is the default for everything

For a person with several protocols, the contact's default chat protocol decides every feature
that has to pick a network, until the person picks another carrier in the picker for a new message.

### 4. "Next protocol that can" applies only to NEW content

When the thread's protocol cannot carry **new content** (a message, a file) and the person has
chosen to let another protocol carry it, the fallback goes to the next protocol that can, marked as
a borrowed feature (contacts design, rule 2).

Actions that address **one existing message in one network** are never redirected: **reaction, edit,
delete for everyone, read receipt**. The message lives on a specific network; an edit or reaction
sent through another is a different message, a wrong one or none. If the thread's protocol cannot do
them, they are simply **absent** from that thread.

### 5. Contacts rule 1 narrows

Rule 1 of `docs/design/contacts.md` says what happens to a *new message*: the carrier is what the
picker said, a refusal is visible, the text stays. It does not claim that every feature of a person
resolves at one protocol. The paragraph is reworded to name new content and to point at this ADR for
actions on existing messages.

## Consequences

- `BackendCapabilities` stays (manifest, upper bound). A new per-thread query returns a narrowed set;
  its first user is mail/Delta Chat (the peer's `Chat-Version`), its second XMPP, whose `features`
  call is moved behind the shared shape.
- Frontends ask the thread, not the backend; the CLI and MCP follow, so an agent is not offered
  what the window would hide.
- New required fields on capabilities need all manifests and fakes updated; new per-thread fields
  stay optional until every backend answers.
- Tests: a thread without the marker offers no reaction row; a thread with it does; a merged
  contact's reaction never goes to another protocol.
