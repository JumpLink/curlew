# Receiving daemon


Signal and WhatsApp have no server archive: a message is gone from the network
once this device acknowledged it, so whatever curlew stores is the **only**
copy. `curlew sync` from a timer narrows the window in which nothing is
received; `curlew daemon` closes it.

```bash
curlew daemon                   # receive until stopped (SIGTERM/SIGINT)
```

It connects to every **delivery-only** backend you enabled — Signal and
WhatsApp — for every account, all at once, and keeps receiving. Mail and chat
backends (IMAP, Telegram) stay on `curlew sync`: they are
pull models with a cursor, and a daemon buys them nothing. Every enabled XMPP
account is followed as well, so replies arrive live, and so is every
account of an enabled Matrix backend (a long-polling `/sync`, read-only, no
presence; a new message wakes an ordinary catch-up). While the daemon follows an
account, `curlew sync` leaves that account to it (one device, one crypto store, one
to-device stream) and says so on stderr. A dropped connection
is retried with growing pauses (5 s to 5 min); a device the network **logged out
or unlinked** is not retried — the daemon stops that account and says so, because
the credentials are gone and every retry would fail the same way while messages
queue up on the network.

Run it as a user service (the unit ships in
[`contrib/systemd/curlew-daemon.service`](../../contrib/systemd/curlew-daemon.service)):

```bash
mkdir -p ~/.config/systemd/user
cp contrib/systemd/curlew-daemon.service ~/.config/systemd/user/
# point WorkingDirectory/ExecStart at your checkout if it is not ~/curlew
systemd-analyze --user verify ~/.config/systemd/user/curlew-daemon.service
systemctl --user daemon-reload
systemctl --user enable --now curlew-daemon
loginctl enable-linger "$USER"     # so it also runs while you are logged out
journalctl --user -u curlew-daemon -f
```

Mail and the pull-model chats need a timer instead: `contrib/systemd/curlew-sync.service`
plus `curlew-sync.timer` run `curlew sync` 15 minutes after the previous run ended.

```bash
cp contrib/systemd/curlew-sync.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now curlew-sync.timer
```

The unit deliberately does **not** stop when you log out — staying connected is its whole
point, and the one thing it uses from your session (the address book, for the participant
link) is optional: without it it still receives, and the link appears on the next rebuild.
`loginctl enable-linger` is what lets a user unit run at all while you are not logged in.

The daemon writes **one line per state change** to stderr, which journald
collects — connected, a batch with its counts, a reconnect in N seconds, a
logout, a stop. Never message text, chat titles, peer names or phone numbers:
a log line is a file that gets copied and pasted around, and the same privacy
rule that guards the index guards it.

**Live updates.** The daemon tells listeners that the index changed, over the session
bus (`eu.jumplink.curlew.Daemon1`, [ADR 0007](../adr/0007-live-updates-over-the-session-bus.md)):
`Changed(seq)` after its own writes and whenever a poll every 2 s finds that a `sync` or
`send` moved the change journal, `AccountsChanged` plus `GetAccounts` for each account's state
(`connected`, `connecting`, `reconnecting`, `logged-out`, `held-elsewhere`, `stopped`). Ids,
states and numbers only — never message text. `curlew watch` is the reference listener: one
JSON line per journal row, starting at the newest (`--since <seq>` starts earlier). Without a
daemon it says so once and reads the journal every 2 s itself; it follows the daemon
coming and going on the bus, subscribing and reading once when one appears and saying once
when it leaves. A
`{"resync":true,…}` line means the journal moved past you: read what you show again.

**And `sync` at the same time?** Yes — and that is what the **lease** is for.
Both take a lease on each delivery account, stored in the index itself: whoever
holds it refreshes it every 30 seconds and drops it when it stops. A `sync` that
finds a live lease reports that account as received by the other run and moves
on — not an error, because nothing failed. A daemon that finds one **waits** for
it and takes the account as soon as it is free, rather than never receiving it:
that includes a `sync` in the middle of a WhatsApp catch-up, which can run for
ten minutes. Two connected devices on one Signal account would each acknowledge
half the messages, so this is what keeps the copy whole. A run that was killed
leaves a lease behind, which expires by itself after 90 seconds.

Stopping is a normal end: SIGTERM (or `systemctl stop`) closes every session,
writes what was in flight, rebuilds the conversations once and exits 0. It is
never a kill — an unacknowledged message is still on the network, and a written
one must never be lost.

**When the unit fails.** If every account was logged out — WhatsApp unlinked the
device after ~14 days, or Signal did the same — the daemon exits **2**, the unit
is not restarted (a restart cannot relink anything) and shows as failed:

```bash
systemctl --user status curlew-daemon   # "code=exited, status=2"
journalctl --user -u curlew-daemon -n 20
curlew accounts add whatsapp            # or: curlew accounts add signal
systemctl --user restart curlew-daemon
```

Anything else exits 0, including a plain `systemctl stop`.

What the daemon does **not** do: send a message, mark anything read, or touch a
server-archive backend. It is the same fail-closed curlew, connected all the
time. See [ADR 0002](../adr/0002-receiving-daemon.md) for why each piece is
the way it is.

