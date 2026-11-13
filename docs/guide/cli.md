# Command line and setup

Curlew's CLI is a side road: the window is the app. Everything here also backs the MCP server.


- GNOME Online Accounts + Evolution Data Server (Fedora:
  `gnome-online-accounts`, `evolution-data-server`), and `libgda-sqlite` for the
  index
- A running user session D-Bus — the GOA and EDS daemons are reached over it, so
  a bare SSH session without one will report the backend as unavailable
- GNOME accounts, contacts and calendar run on Node/Bun too (`gi://` via `@gjsify/node-gi`);
  that is groundwork for a macOS/Windows port, not a supported target yet. The IMAP mail
  transport is GJS-only, since it speaks IMAP over Gio TLS sockets. Without the GOA/EDS
  typelibs Curlew still starts: only the calls that need them fail, with a clear message.
- An **Email (IMAP/SMTP)** account: either one added in Curlew (*Add Account → Mail*) or an
  *Email* account in GNOME Settings. Nextcloud/ownCloud accounts expose files, calendar and
  contacts but no mail.
- Implicit TLS (port 993). STARTTLS on port 143 is not implemented yet.

## Install and run

```bash
gjsify install
gjsify workspace curlew-cli build
gjsify run app/dist/curlew.gjs.mjs accounts
```

The bundle resolves its native addon (libsignal, for the Signal backend) by the
absolute path it was built at, so do not move or copy a built tree — the copy
fails at the first Signal command. `curlew-cli test:relocation` measures this
and says so out loud; the fix is tracked in gjsify.

### Desktop install (development)

`npm run packaging:install` copies the desktop entry, the hicolor icons and the
metainfo from `app/data/` into `~/.local/share` and refreshes the desktop and icon
caches — the step that makes GNOME Shell show Curlew in the app grid, match its
window to the launcher (`StartupWMClass=eu.jumplink.curlew`, the GTK application
id) and find the window icon by name. It is idempotent and installs nothing else:
`Exec=curlew window` calls whatever `curlew` your machine has on `PATH`, and no
systemd unit is touched — that wiring is [`curlew setup`](#setup)'s or your own.

### Setup

`curlew setup` walks you through the whole thing — linking Signal and WhatsApp,
accepting their terms, building the index, running the receiving daemon and
installing its systemd user unit — one confirmed stage at a time:

```bash
curlew setup
```

It finds the checkout it is run from, and falls back to a published `curlew` on
`PATH` when there is no tree. `curlew setup --status` reports what is done and
what is left without changing anything, and `curlew setup --only <stage>`
runs the named stages and nothing else — `--status` prints the name of every
stage. `--only` may be repeated (`--only terms --only link-signal`) to pick more
than one.

Re-run it whenever: a stage that is already done says so instead of failing.

The QR code and every pairing code it prints stay in that terminal. curlew
calls the same account-adding command you would call by hand, with the same
prompter, and neither copies, captures, logs nor stores a pairing payload. The
terms are displayed before you are asked to accept them, and nothing accepts them
for you.

## Use it

```bash
curlew check                              # which backends are reachable
curlew accounts                           # which online accounts are available
curlew folders                            # mailboxes, with their roles

curlew search "energieberater" --since 2025-01-01
curlew search --from berater --all-folders --limit 20
curlew message <uid> --account <id>       # one message: body + attachment list
curlew parts <uid> --account <id>         # what is attached, and how big
curlew save <uid> --account <id>          # write the attachment to disk

curlew sync                               # build the local index
curlew index status                       # what it holds, and how fresh
curlew index search "wärmepumpe"          # offline, no server contact

curlew daemon                             # receive Signal/WhatsApp until stopped
curlew watch                              # one JSON line per index change, as it happens

curlew conversations list --people-only   # threads with a person in them, newest first
curlew conversations show <id>            # its messages; bodies only with --bodies
curlew conversations classify <address> automated   # correct one sender (auto = undo)

curlew backends list                      # message backends, and which are enabled

curlew contacts --query maier
curlew calendar --from 2026-09-01 --to 2026-09-30
```

Every command prints JSON — the same shapes the MCP tools return.

`search` returns headers only, never bodies; reading one message is a separate,
explicit call, and getting an attachment's bytes a third. That is not a policy
you can flip with a flag — the search path contains no code that can fetch a
body.

`--since` and `--before` filter the message **Date** header, not its arrival
time. After a mailbox migration every message's arrival timestamp is the
migration date, which makes an arrival filter useless; `--received-since` is
there when you genuinely mean arrival.

Search folds diacritics, so `marz` finds `März`. (`ß` is a letter rather than a
diacritic, so `grusse` does not find `Grüße`.)

`sync` also groups mail into **conversations** by `Message-ID`, `In-Reply-To` and
`References`, and classifies each one: *conversational* (a known contact, or a
thread you replied in) or *automated* (`List-Id`, `List-Unsubscribe`,
`Auto-Submitted`, `Precedence`, no-reply senders). A stranger nobody replied to
is held back until you reply or classify the sender. This is the groundwork for
chat backends ([ADR 0001](../adr/0001-multi-protocol-messenger.md)): each
backend is enabled explicitly in the config, and one with a terms notice only
after `curlew backends enable <name> --accept-terms`.

