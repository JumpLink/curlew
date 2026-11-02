# ADR 0007 — live updates: a change journal in the index, a wake-up on the session bus

- **Status:** Accepted (2026-11-02)
- **Scope:** `@curlew/store` (a change journal, schema v10, additive), `app` (`curlew daemon`
  emits, `curlew watch` reads), `app/src/core/lib/daemon-bus.ts` (the interface); later the GUI

## Context

The GUI that comes next has to show a message when it arrives and an account's link state when
it changes. Today nothing tells anyone: `curlew daemon` writes the index (ADR 0002) and says so
in a log line, `curlew sync` and `curlew send` write it from their own processes, and a reader
learns about any of it only by asking again.

Four facts shape the answer.

**There are several writers in several processes.** The daemon, a `sync` from a timer or a
terminal, and a `send` that indexes what it sent (`recordSentChatMessage`). A notification only
the daemon emits for its own writes would miss two of three; one that every writer emits needs
every writer to find the bus and a listener that tells the senders apart.

**The index is the truth, and it is the only copy for delivery-only accounts.** A reader that
builds its picture from events instead of from the index has a second truth that drifts the
first time an event is lost — a GUI started after the event, a bus restart, a signal dropped
under load. The XMPP follow mode (ADR 0004 §5) already settled this shape for one backend: a
stanza is a wake-up, the archive is the truth.

**The index cannot carry triggers.** libgda's `exec()` cuts a `BEGIN … END` body into
fragments (`packages/store/AGENTS.md`, trap b), so "every write appends a change row" cannot be
done by the database for us. It has to be written by the write paths, in their transactions.

**The session bus is readable.** Any process of the user can `dbus-monitor` it, and bus traffic
ends up in bug reports. The log-line rule of ADR 0002 §6 applies: no message text, no titles,
no peer names, no phone numbers.

## Decision

### 1. A change journal in the index (schema v10, additive)

One table, `index_changes`:

| column | meaning |
|---|---|
| `seq` | `INTEGER PRIMARY KEY AUTOINCREMENT` — monotonic, never reused, the only cursor a reader keeps |
| `at` | ISO time of the write |
| `kind` | `messages` · `conversations` · `accounts` |
| `backend`, `account_id` | which account the write was for; null for `conversations` |
| `conversation_id` | the chat's conversation id when the writer knows it (every chat and delivery write: `chatConversationId` is a pure hash), null for mail — a mail thread is only known after the rebuild |

**Every write path appends, inside its own transaction, one row per affected conversation per
batch** — not one per message: a 4 000-message first sync is a few hundred rows, and the reader
re-reads a conversation, never a message. The write paths are the chat sync, the delivery
receive (including its deletion events), the mailbox sync (one row per account per pass, with
`conversation_id` null), `recordSentChatMessage`, and `rebuildConversations` (one
`conversations` row per rebuild). A write that changes nothing appends nothing.

`accounts` rows record a change of link state the store already persists (ADR 0003's degraded
state, a logout). Transient state — connected, reconnecting in N s — is not written to the
index; it is the daemon's to report (§3).

The journal is **pruned** by the writer that appends, to the last 10 000 rows or 7 days,
whichever keeps more. A reader whose cursor is older than the smallest `seq` left has missed
changes it cannot name, and does what it does at startup: reads everything it shows. That is
the only recovery path, and it is the same one a first start takes, so it is always exercised.

No row carries content: kinds, ids and times, the same as a log line. The `seq` is local to
one index; it means nothing on another machine and is never synced.

A store function `readChanges(db, afterSeq, limit)` returns the rows after a cursor plus
`{ oldest, newest }`, so a reader can tell "nothing new" from "you fell behind". It is the one
reader API; the GUI, `curlew watch` and the daemon's own poll use it.

### 2. The daemon wakes listeners; it does not describe the change

The daemon exports, on the object it already owns (`/eu/jumplink/curlew/Daemon`,
`eu.jumplink.curlew.Daemon1`), one signal:

```xml
<signal name="Changed">
  <arg type="t" name="seq"/>
</signal>
```

`seq` is the newest journal row. That is the whole payload: a listener calls `readChanges`
with its cursor and learns the rest from the index, which it reads anyway. Not a JSON string
like `Send` — a single number has no version to negotiate and no field to add.

The daemon emits it **after its own commit** (no debounce on that path — the commit is the
event) and **on its poll**: every 2 s it reads `max(seq)` and emits when it moved. The poll is
what makes the other writers visible without making them bus clients: a `sync` from a timer or
a `send` in a terminal only has to write its journal row, which it does in the transaction it
already runs. One indexed `SELECT max(seq)` every 2 s is not a cost worth designing around; a
`Gio.FileMonitor` on the WAL file was considered and rejected — it fires on every page write
including the daemon's own, and the WAL file's name and lifetime are SQLite's, not ours.

A listener never needs the signal for correctness. It reads after its cursor on start, on every
`Changed`, and when it reconnects to the bus; a lost signal costs latency until the next one,
never a message.

**Conversations stay debounced** (ADR 0002 §5: 30 s after the last batch). The GUI does not wait
for them: a chat's conversation id is known at write time (§1), so a new message is shown in
its conversation straight from the `messages` row, and the list's ordering catches up with the
`conversations` row. Mail is the exception, because its thread is not known before the
rebuild; for mail the debounce is what the user sees, and shortening it is a measurement for
later, not a guess now.

### 3. Link state: a property-like pair, also JSON-free of content

```xml
<method name="GetAccounts">
  <arg type="s" name="accounts_json" direction="out"/>
</method>
<signal name="AccountsChanged"/>
```

`GetAccounts` answers, per account the daemon is responsible for, `{ v, accounts: [{ backend,
accountId, state, since, retryInMs? }] }` with `state` one of `connected` · `connecting` ·
`reconnecting` · `logged-out` · `held-elsewhere` · `stopped`. It is the same set of state
changes the log already writes one line for (`line()` in `daemon.ts`), so a new state is one
mapping, not a second state machine. `AccountsChanged` carries nothing and is emitted when any
entry changes; the listener asks. Account ids are opaque network ids by the invariant ADR 0002
§6 pins with a test, so they may cross the bus for the same reason they may enter the log.

JSON here and not a typed signature for the reason `Send` gave: the entry will grow (the
backoff attempt, the lease holder) and an `s` signature does not change when it does. The
reply carries its own `v`, independent of the send wire's.

### 4. `curlew watch`

A CLI command that holds a cursor and prints one JSON line per journal row as it arrives —
the reference listener, the thing the integration test drives, and what a person runs to see
whether the daemon is alive. With no daemon on the bus it says so once and falls back to its
own 2 s poll of the journal, so it works on a machine with only `sync` from a timer. It prints
what the journal holds and nothing else: no text, no titles.

No MCP tool: an agent asks the index when it needs to, and a streaming tool would be the first
one that never returns.

### 5. What is live is a separate question from how it is reported

This ADR decides how a change reaches a listener once it is in the index. **Which backends
write while the daemon runs** is unchanged by it: Signal and WhatsApp (ADR 0002) and the
XMPP accounts a grant names (ADR 0004 §5). Matrix, Telegram and mail stay on `curlew sync`
until each gets a follow source of its own, each in its own change:

- **Matrix** first: the sync loop is already read-only through `readOnlyFetch`, a long-polling
  `GET /sync` with `set_presence=offline` is exactly what that gate passes, and the account
  file is already the crypto store's snapshot. It needs the receive lease like every other
  follow, so a `sync` stands down for it.
- Telegram's update stream and IMAP IDLE after that, in that order.

The journal does not care which of them wrote: a row is a row, which is why this is decided
first.

### 6. Workers: not a replacement for the bus, a way to keep main loops free

gjsify 0.64.16 ships a WHATWG `Worker` (`@gjsify/web-worker`) over `worker_threads`; on GJS a
worker is a child gjs process, ready in ~40 ms, and Comlink works over it (gjsify report
`2026-10-30-web-worker-and-comlink-on-gjs.md`). It changes none of the above, and it is the
right tool for two places beside it:

- **Not the transport between daemon and GUI.** A worker belongs to the process that spawned
  it and dies with it; the daemon runs under systemd and outlives every GUI window. Owning a
  bus name is also the liveness check (ADR 0004 amendment). The bus stays.
- **The journal holds across workers by construction.** A worker is its own process with its
  own libgda connection; a write from it appends its row in its own transaction and the daemon's
  poll sees it like a `sync` from a timer. A daemon may wake itself from a worker's message
  instead of waiting for the poll — an optimisation, not a second path.
- **The GUI reads the index in a worker.** `readChanges` and the conversation queries run off
  the GTK main loop, as stamped's query worker does; nothing in §1 assumes the main thread.
- **The daemon's rebuild is a candidate.** `rebuildConversations` is synchronous and, while it
  runs, holds back `Send` replies and `Changed`. Whether it moves into a worker is decided by
  measuring it on a real index, not here.

Using any of this needs curlew on gjsify 0.64.16 or later (it is on 0.64.12); the bump comes
first, all eight `@gjsify/*` packages together. Running each backend in its own worker for
crash isolation (WASM out of memory, a native addon fault) is a separate decision.

## Consequences

- Schema v10 adds one table and nothing else; no existing row is rewritten (the delivery-only
  index is irreplaceable — ADR 0002, consequences).
- Every write path gains one append in a transaction it already has. A write path that forgets
  is a GUI that does not update for that kind of write until something else bumps the journal —
  so each path gets a test that a write appends its row, and the next one added has a test to
  copy.
- The daemon becomes the GUI's live source but not its data source. A GUI without a daemon
  still shows everything; it only stops being live, and it says so (ADR 0003's rule:
  degraded is stated, not summarised).
- `Changed` and `AccountsChanged` are additive to `eu.jumplink.curlew.Daemon1`; the send wire's
  version does not move.
- The bus carries ids, counts and states. The rule that keeps it that way is the log-line rule,
  and the test that pins the account-id derivation (ADR 0002 §6) now protects the bus as well.

## References

- ADR 0002 §4–§6 — the lease, the debounced rebuild, the log-line rule
  ([0002-receiving-daemon.md](0002-receiving-daemon.md))
- ADR 0003 — degraded state is stated ([0003-degraded-link-state-is-user-visible.md](0003-degraded-link-state-is-user-visible.md))
- ADR 0004 §5 and the 2026-10-30 amendment — XMPP follow as wake-up over the archive; the
  daemon's bus name and `Send` ([0004-sending-and-writing-granted-per-capability.md](0004-sending-and-writing-granted-per-capability.md))
- `packages/store/AGENTS.md` — why there are no triggers
