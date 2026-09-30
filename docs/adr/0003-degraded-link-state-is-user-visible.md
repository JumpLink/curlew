# ADR 0003 — a linked device in a degraded state is stated, not summarised

- **Status:** Accepted (2026-09-30)
- **Scope:** `app` (setup walkthrough, status report), `@postbote/store` (index schema),
  `@postbote/signal`; later the GUI

## Context

A device can be **registered with Signal and still be second-rate**, and the difference is not
visible from the outside:

- **One-time pre-keys.** At link time a device uploads a hundred of them. Each incoming message
  consumes one. A device that never published them receives only through its last-resort key,
  which is the fallback path by name and which Signal has been retiring for accounts that do
  supply one-time keys.
- **A dropped link.** Removing the device on the phone leaves the session file on this machine.
  A local file is evidence of an attempt, not of a live link.

Both states produced output that was **true in its words and wrong in its effect**:

```
Linked, but the one-time keys were not published (status 401);
new contacts fall back to the last-resort key.
```

`Linked.` is the headline. The clause after the semicolon names a symptom without saying that the
condition **persists and does not heal** — nothing in the client can upload those keys later.

```
Signal is already linked on this machine — nothing to do.
```

A session file existed, Signal had not been asked, and the sentence claimed a live link.

## Decision

**State the consequence, not the fact that something went wrong.** A message about a degraded
device says what the device can and cannot do, and it says whether the condition lasts.

- The missing pre-keys are named as a lasting limitation of this device, in the sentence that
  reports the link, not as a trailing clause behind a success.
- A session file on this machine is **not** reported as a live link. The report says a session
  from an earlier link is present, that it has not been checked with Signal, and that `sync` is
  what finds out.
- Once a sync **has** found out, that is a fact and may be stated plainly: the link is gone, and
  what to do about it.

The rule this encodes is not about volume. **It is about whether a consequence has occurred.**

| State | Report |
|---|---|
| Transient, no lasting effect | may stay a footnote — it would be alarm without cause |
| Lasting effect, does not heal on its own | belongs in the sentence that reports the outcome |
| Unknown, because nothing asked | say that it is unknown, never imply otherwise |

A status report stays **local**: it reads what the last sync learned rather than calling the
server. A report that cannot answer offline cannot answer at all, and the fact travels through
the sync that already made the contact.

## Consequences

- `accounts.link_dropped_at` (index schema v7) carries what a delivery sync learned; it is
  **cleared** by any run that reaches the account again, so a restored link is not reported as
  broken. The `setup --status` walkthrough reads it and reports a dropped link as remaining work.
- **A GUI has no excuse to be quieter than the CLI.** When it is built, the same rule applies with
  one addition: a degraded device needs to be visible *without* a run happening first, since a
  window can be opened long after the sync that would have found out. The CLI can say "run sync"
  because its output is a moment in a run; a window cannot.
- The wording is pinned by tests. Both the old claim and the new one are asserted, so changing it
  stays a visible decision rather than a reword.