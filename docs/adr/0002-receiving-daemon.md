# ADR 0002 — the receiving daemon, and the lease that keeps two of them apart

- **Status:** Accepted (2026-09-29)
- **Scope:** `@postbote/protocol` (`DeliveryOutcome`), `@postbote/store` (the receive path,
  schema v6), `app` (`postbote daemon`, `postbote sync`)

## Context

ADR 0001 §2 splits the backends by sync model. A **server archive** backend (IMAP, Telegram,
Matrix, XMPP) can be read whenever: the network still has the history, and `postbote sync`
walks a cursor. A **delivery-only** backend (Signal, WhatsApp) cannot. The server holds a
message for a device only until that device acknowledges it; after that nothing anywhere else
in postbote's world has it, and what `receiveDeliveries` wrote is the only copy — `state` in
the backup sense, not `derived`.

That makes "sync every so often" a data-loss window, not a freshness window. WhatsApp unlinks a
linked device that has not connected for about 14 days; Signal does something similar. Inside
that window the only cure is a run, and a human has to be there to start it. ADR 0001's
consequences said a daemon (a systemd user unit) arrives with the first delivery-only backend;
this is that decision record.

Three things stand between the current code and a daemon that can be left running unattended.

**A follow session never ends.** `DeliverySession.nextBatch()` resolves `null` when the session
is over; in `catch-up` mode that is once the backlog is delivered, in `follow` mode only after
`close()`. `receiveDeliveries` runs one account after another, awaiting each — fine for a
catch-up run, structurally wrong for a daemon: two accounts would take turns, and the second
starves for as long as the first is connected.

**Nothing stops a run from outside.** `receiveAccount` has no cancellation. A daemon that
cannot be stopped cleanly is worse than no daemon: `systemctl stop` escalates to SIGKILL, and a
delivery-only network's in-flight batch is only safe because it was acknowledged after the
write.

**Nothing keeps `sync` and the daemon off the same account.** Both open a socket to the same
device. Two connected devices on one Signal account consume two slots and both acknowledge, so
the two runs interleave and each sees the other's share — neither ends up with a complete
picture, and a reconnect storm on one is a reconnect storm for both.

## Decision

### 1. Scope: the enabled delivery-only backends, every account, `follow`, concurrently

`postbote daemon` receives the backends whose manifest declares `syncModel: 'delivery-only'`
and that the config enables — today Signal and WhatsApp — for every account each of them
lists, in `mode: 'follow'`, all accounts **at once**. The choice of driver is still
`isDeliveryBackend()`, never a backend name; the config decides which are enabled, and the
terms gate still runs, so enabling the daemon cannot reach a backend the user did not accept.

`receiveDeliveries` keeps its account loop sequential for `catch-up` (a bounded run reports per
account, and one slow account must not starve the others of the time budget) and runs them
concurrently for `follow`, where the loop is the point: it must not be a queue.

Mail and chat backends stay on `postbote sync`. They are pull models with a cursor; a daemon
buys them nothing and would keep the index's write path busy for hours to no end.

### 2. Stopping from outside: an `AbortSignal` on the receive path

`DeliverySyncOptions` takes a `signal`. On abort the engine closes the session, `nextBatch()`
resolves `null`, and the account loop ends **normally** — a stopped daemon is a successful
run, not an error in the log. `SIGTERM` and `SIGINT` abort it, every account loop is awaited
(the last batch is written; nothing was acknowledged that is not on disk), conversations are
rebuilt once, the database is closed, and the process exits 0.

`process.on('SIGTERM')` was **measured** under gjsify 0.49.0 rather than assumed: gjsify's
process module delivers `SIGHUP`/`SIGINT`/`SIGTERM` through `GLibUnix.signal_add()` and the
handler runs on the JS thread. No shim, and none should be added at a version bump — the
handler is only reached while something pumps the main loop, which is what the CLI's
`GLib.MainLoop` is for.

### 3. Reconnect with backoff, and a terminal state for a device that is gone

A session that ends with an `error` in `follow` mode is a dropped socket, not a verdict: the
daemon reconnects, with exponential backoff from 5 s doubling to a 5-minute cap. A session
that lived longer than the cap counts as healthy and resets the backoff, so a network that
drops hourly does not spend the rest of the day waiting five minutes.

A device that was **logged out or unlinked** is the opposite: the credentials are gone and
every retry fails the same way. That is a terminal state and gets an explicit marker,
`DeliveryOutcome.loggedOut`, set by both receivers at the place where they already detect it
(Baileys' `DisconnectReason.loggedOut`; libsignal's `DeviceDelinked`/`RequestUnauthorized`).
The daemon stops that account, says so in one log line and does not retry. Guessing it from
the error text would be wrong in both directions: Signal also reports
`RequestUnauthorized` for a temporary condition, and a retried-but-dead account is a silent
data-loss machine.

Clock and sleep are injected, so the backoff is a function under test and not a second of
wall clock.

### 4. The lock is a lease in the index database (schema v6, additive)

One row per `(backend, account)`: the holder's pid and a heartbeat timestamp. **Both** the
daemon and `postbote sync` take the lease before they connect an account, refresh it while they
receive, and drop it when they stop — a one-sided lock is no lock: a `sync` in the middle of a
WhatsApp catch-up (up to ten minutes) would still let a daemon join it. A lease whose heartbeat
is older than three intervals is stale — the holder crashed — and is taken over.

Take, refresh and release are read-decide-write inside `BEGIN IMMEDIATE` with a busy timeout, so
two runs starting at once cannot both win: a deferred transaction would read "free" and both
would try to write, and SQLite does not run the busy handler for that upgrade. The lock was
measured cross-process on both runtimes, and a contender that runs out of patience is reported as
"not acquired" — a `sync` stands down, a daemon waits and takes the account when it is free.

`postbote sync` skips a delivery account with a fresh lease and reports it as *received by the
running daemon*. Not an error and not counted in `errors`/`failed`: nothing failed, the
messages are being received, and a `sync` that red-flags a working daemon trains the user to
ignore red flags.

A lease rather than a lock file, for three reasons: it is one transaction in the same database
as the data it protects, so there is no second file to place, secure or keep in sync; it
survives a crash by expiry instead of by a cleanup path that also has to survive a crash; and
it works identically on Node and GJS, where `flock`/`fcntl` locking is not something to assume.

### 5. Conversations: the same rebuild `sync` does, debounced

`rebuildConversations` runs after the writes, 30 s after the last written batch, and once on
stop — a burst of messages is one rebuild, not one per batch. It is the same rebuild with the
same address-book step `indexSync` performs; the address book is read once and the step is
extracted into a shared helper, because a second copy of the classifier's address book is a
second set of bugs.

### 6. Logs: one line per state change, and no content at all

State changes — account connected, a batch with its counts, a reconnect in N s, a logout, a
stop — go to stderr as single lines, where journald collects them. Counts, the backend name
and the account id only: never message text, chat titles, peer names or phone numbers. The
index holds other people's words; a log line is a file that gets copied, indexed and pasted
into a bug report, and the same rule as the index itself applies to it.

### 7. systemd user unit, shipped in the repo

`contrib/systemd/postbote-daemon.service`, `Restart=on-failure`, `ExecStart` matching how the
README installs postbote (`gjsify run <repo>/app/dist/postbote.gjs.mjs daemon`) so the unit is
a copy of a command that already works. A user unit, not a system one: postbote reads
`$XDG_DATA_HOME` and GOA over the user session's D-Bus, so it must run as the user anyway.

## Consequences

- `receiveDeliveries` gains an `AbortSignal` and, in `follow` mode, concurrency; `catch-up`
  keeps its sequential shape, and every existing test keeps its shape too.
- `DeliveryOutcome` gains an optional `loggedOut`; a backend that does not set it reconnects.
- The store gains one table (schema v6) and no migration that rewrites a row — the index is
  irreplaceable for a delivery-only account and must not be rebuilt to add a table.
- `postbote sync` and the daemon are two writers to one index by design, and the lease is the
  only thing that keeps them apart. Anything else that connects a delivery account (a manual
  `sync` on a machine where the daemon runs, a second daemon in another session) must go
  through the same lease or be a bug.
- The daemon is the only postbote command that is expected to run for months: the reconnect
  backoff, the lease heartbeat and the debounced rebuild are the three places where that shows.
- `postbote sync` stays a complete command on its own. With the daemon running, a `sync` for
  mail, chat backends and the conversations is still exactly what it was; only the delivery
  accounts it skips change.

## References

- ADR 0001 §2 (the two sync models) and its consequences ("a daemon arrives with the first
  delivery-only backend") — [0001-multi-protocol-messenger.md](0001-multi-protocol-messenger.md)
- `packages/store/AGENTS.md` → "Delivered chats are the only copy"
- gjsify 0.49.0: `@gjsify/process` signals, measured on GJS 1.88.1
