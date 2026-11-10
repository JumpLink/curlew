# Changelog

## Unreleased

### Fixed

- Files under `/tmp` could not be sent through the daemon ("cannot be read"), because its unit gave it a private `/tmp`. The unit no longer does; `curlew setup` writes the new one, an existing unit needs the line `PrivateTmp=true` removed.
- Pictures and files of chat messages synced before 0.2 showed only a blank *Attachment* tile.
  The sync now walks the history of Telegram and Matrix chats again, ten chats and five pages
  per chat per run, and writes only the attachment descriptors; messages, read state and edits
  stay as they are. A message the network no longer shows with an attachment keeps the plain
  tile without a download.
- Opening a video or file from a chat or mail bubble no longer stops at 25 MB; the window may
  fetch up to 100 MB, since a phone video is often bigger than the limit meant for agents.

### Changed

- The cache of fetched attachment previews is capped at 1 GiB while the window runs; the least recently fetched parts are dropped first and a tap fetches one again. It used to grow until the window was restarted.
- `curlew window`: the filter chips are pills that fill with the accent colour while on, and the
  protocol badge sits on a solid circle at the avatar's rim, so it is legible and no longer covers
  the initials. gjsify 0.64.19.
- An agent that sends files is asked first on mail as well, not only on chats. The new switch
  *Send files without asking* (`agentAccess.sendFilesUnasked`, off by default) on the *Agent
  access* page lets an `allow` rule send files unasked, for mail and chats alike.
- Setting up a network with a terms notice (WhatsApp, Signal, Telegram) asks you to tick *I
  understand and accept the risk for my account* before *Accept and Continue* is enabled.

### Added

- WhatsApp chats can send a reply too: the message goes out quoting the one it answers.
- Signal chats can send a reply too: the message goes out as a quote of the one it answers.
- XMPP chats can send a reply too (XEP-0461). Messages synced before this version need a full scan of the chat first.
- Long press or right click on a bubble opens *Reply* and *Copy*. A reply shows a bar above the composer and goes out as an answer on Matrix and Telegram; the other networks hide the entry until they can send replies. The daemon speaks wire version 4 now: restart it with `systemctl --user restart curlew-daemon` after the update.
- Pressing the quote above a reply scrolls to the message it answers.
- A reply shows the message it answers above its text: the author and a short excerpt. Needs the quoted message to be on the page already; older targets are not looked up yet.
- The media viewer has an *Open with…* button that lets you pick the application, and its error page a *Try Again* button.
- The media viewer steps through the other pictures and videos of the same message: arrows over the edges, left/right keys and a swipe, with the position (2 / 4) under the title. Pictures and videos in a bubble carry an accessible label with their name.
- Voice messages and audio files in a chat bubble play in place: a play/pause button, a seek bar and the position out of the length. The part is fetched on the first press, only one plays at a time, and a bubble that leaves the window stops its sound. The buttons carry labels for screen readers.
- A single video in a chat plays muted and in a loop while it is on screen, one at a time and only while the window has focus. The new switch *Play videos silently in chats* under Preferences turns it off; it starts off when the system asks for fewer animations.
- WhatsApp sends files: `curlew send --attach` and the window's attach button work on WhatsApp
  chats, up to 10 files of 64 MB, one message each, the text as the caption of the first. The
  daemon wire version is 3, so restart the window and the daemon together.
- A chat video up to 8 MB shows its first frame in the bubble with a play symbol; pressing it opens the viewer.
- Two or more pictures and videos of one message form a grid in the bubble, and a video shows its length.
- Telegram albums (several pictures and videos sent together) show as one bubble with a grid; older
  messages are grouped as the attachment backfill reaches them.
- Desktop notifications for new chat messages. The daemon notifies for an incoming, unread
  message of a chat (never mail) that arrived after it started, so catching up on a backlog is
  silent. One notification per chat, replaced as more messages come; more than four chats in one
  poll fold into one summary. Clicking it opens the window at that chat. *Preferences* has a
  *Message notifications* row (sender and text, sender only, off), stored as
  `config.ui.notifications`. Design: `docs/design/notifications.md`.

- `curlew window` is a chat client. A conversation opens as bubbles with paging, day separators,
  the sender in groups and a composer that sends through the daemon or the backend. One person
  who writes on several messengers is one row and one chat; the composer and the header menu pick
  the protocol, *Only via {protocol}* pins it, and a merge assistant offers people with similar
  names (a local grouping only: the address book and the messages stay as they are). Your own
  chat with yourself shows as *Note to self*. Design: `docs/design/contacts.md`.
- Attachments across protocols (ADR 0010). Telegram, Signal, WhatsApp, Matrix and XMPP list the
  files of a message; the window fetches one through the daemon on demand, shows small pictures
  in the bubble (up to 2 MB, fetched when the bubble is in view) and opens anything else from a
  tile. Agents get the read-gated tool `message_save_attachment`. The daemon wire version is 2.
- Sending files from the window: a paperclip in the composer for Telegram, Matrix and XMPP.
  An agent sends a file to a chat only after you confirm in a prompt that lists the file names,
  never the paths; a file to your own address needs no prompt. Signal and WhatsApp still refuse
  attachments.
- Accounts in the window: add a chat account, switch one off, remove one (its messages stay),
  and start the background service from the banner.
- AppStream metadata and screenshots describe Curlew as a chat client, in English and German.

- `packaging:install` (new `scripts/install-packaging.sh`): installs the desktop entry, the
  hicolor icons and the AppStream metadata into `~/.local/share` — honouring `XDG_DATA_HOME`,
  `PREFIX` and `DESTDIR` — and refreshes the desktop and icon caches, so GNOME Shell lists
  Curlew, matches the window to its launcher and finds the window icon. The desktop file now
  sets `StartupWMClass=eu.jumplink.curlew`. The script writes no `curlew` wrapper and no
  systemd unit; that wiring stays with `curlew setup` and the machine.

- Mail attachments: `send_message` takes `attachments` (absolute paths) and `curlew send` a
  repeatable `--attach <path>`. Mail only; other backends and the daemon send path refuse
  them. Limits: 10 files, 20 MB each, 25 MB total. The permission prompt lists the file
  names and the write log records names and sizes, never content.

- `curlew window`: the first GTK 4 / libadwaita window. A split view whose sidebar is one
  read-only list of every conversation in the index (People and Groups, protocol and account
  chips, search, protocol badge, grey unread count) and which collapses to one pane at 720 sp.
  *Agent access* opens from the primary menu as a dialog that lists and edits the `agentAccess`
  rules — per account and contact, read and write as allow, ask or deny, add and remove a rule,
  and the `askWithoutRule` switch. A rule that comes from an old send grant is shown as such.
  Only the explicit command opens a window. A desktop file and AppStream metadata
  (`eu.jumplink.curlew`) ship with it. Rules: `docs/design/ui.md`.

## 0.2.0

### Added

- `telegram.send`: send one plain-text message (≤ 4096 characters) to a granted Telegram chat with
  `curlew send` or `send_message`. `messaging_capabilities` lists Telegram.
- `matrix.send`: send one plain-text message (≤ 32000 UTF-8 bytes) to a granted Matrix room with
  `curlew send` or `send_message`. The target is `<account>/<room id>`, the room id as
  `conversations_list` shows it. An end-to-end encrypted room is refused — curlew decrypts but
  does not encrypt, and it sends no cleartext there. `messaging_capabilities` lists Matrix.
- `whatsapp.send`: send one plain-text message (≤ 65536 UTF-8 bytes) to a granted 1:1 WhatsApp
  chat with `curlew send` or `send_message`. The target is `<account>/<chat jid>`, the JID as
  `conversations_list` shows it; a bare phone number, a device address, a group and a status
  update are refused. A send takes the receive lease, so it is refused while the daemon holds
  the account — WhatsApp allows one connection per linked device.
  `messaging_capabilities` lists WhatsApp.
- `send_message` takes an optional `format` (`plain` by default, or `markdown`). Markdown is
  rendered as XEP-0393 for XMPP, and texts over 7000 characters are split into several
  messages. The answer then carries `parts` and `originIds`.
- `xmpp_wait_reply` takes an optional `strip_quotes` (default `false`) that removes quoted
  reply lines from the message text.
- Agent access is enforced (ADR 0009): every agent send and every read of a message body is
  checked against `agentAccess` per account and contact — in the MCP tools and in the CLI's
  agent commands. On `ask`, `curlew daemon` shows a notification (*Allow once*, *For this
  session*, *Always*, *Deny*); no answer in 2 minutes, a dismissal or *Deny* refuses. New bus
  method `RequestAccess` on `eu.jumplink.curlew.Daemon1`. Searches that span contacts return only
  the hits you allowed and report `withheld`.
- The access notification names the contact — `Name (address)` — for Signal, WhatsApp, Matrix
  and mail, where the address alone is an ID nobody recognises. The daemon looks the name up in
  its own index; a name in the request is ignored, and none known shows the address as before.
- New read-only MCP tool `messaging_capabilities`: per protocol the maximum message length,
  formats, image support, maximum wait timeout and splitting.

### Changed

- Grants restrict agents, not the person (ADR 0008). The daemon follows every enabled XMPP
  account without an `xmpp.send` grant, and the daemon's bus send service checks no grant.
  `curlew send` and `send_message` still need a grant, except a message to the account itself,
  which every backend recognises in its own spellings (Signal ACI, WhatsApp JID and LID, XMPP
  JID with any resource, mail address, Telegram Saved Messages, Matrix user id) and which needs
  no grant. `send_message` is now always listed.

- **Agents now need access to read message bodies.** With no rule a body is `ask`, so an agent
  that read freely before is asked per contact (or refused when no daemon runs). The old
  `<backend>.send` grants keep working as rules allowing read and write for that pair. A grant
  for one backend's send now also covers the same account and address of another backend,
  because rules are per account. Your own CLI and the GTK app are not affected.

- OMEMO is decrypted for every enabled XMPP account (ADR 0009 §9); the `xmpp.omemo` grant is
  gone and an old config that lists it still loads, the entry ignored. The daemon no longer
  watches the config for grant edits, so it never exits with code 3 to restart.

### Fixed

- The `curlew-daemon.service` description names XMPP.

Calls that omit the new inputs behave exactly as in 0.1.0.

## 0.1.0

First release.
