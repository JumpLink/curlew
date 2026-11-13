# Changelog

## Unreleased

### Fixed

- The window no longer stalls when it opens or is brought back into focus with thousands of conversations: the list rows are built in idle batches instead of one blocking pass (about 1.2 s down to 35 ms on 2000 conversations), the duplicate scan runs when the loop is idle, a refresh on activation waits until the window has painted, and the account names no longer trigger a second full rebuild when they match the index. `CURLEW_DEBUG_STALL=1` logs main-loop stalls and the timing of the list refresh.
- Changing a chat's Design, Accent colour or Chat background on its contact page now shows in the chat behind the dialog at once, not only after the dialog closes.
- The About dialog now shows the version, the licence, the website, the issue tracker, the developer and the copyright; it showed none of the version before. `curlew --version` prints the same number.
- In the Flatpak, an agent's access prompt now appears (through the Notification portal, with the same four buttons) and voice notes can use the microphone (`--socket=pulseaudio`). Both were silently missing in the sandbox.
- Deleting your own Delta Chat message for everyone no longer brings it back when the conversation is rebuilt before the delete mail has synced: the delete is remembered until that mail is seen (at most 30 days). A test also covers that an own edit survives a rebuild, and which entries the bubble menu offers in Delta Chat, plain mail and XMPP threads.
- The conversation search now finds unsent drafts by their text, not only by subject; drafts stay in the list as before (#307).
- A message bubble shows the time of day (14:05) again; for messages older than yesterday it showed the date, which the day separator already gives.
- Delta Chat messages are encrypted, and the window showed every one of them as an empty bubble reading "No text body". It now says "Encrypted message: it cannot be shown here"; the index marks such mail when it syncs, and mail folders with email chats are fetched once more to learn it.
- Removing an account can now also delete its messages, attachments and cached pictures from this computer. A second confirmation says so, and warns when the index is the only copy (Signal, WhatsApp). Without the check mark, nothing changes: only the login goes.
- Telegram profile pictures of people now show in the list; only groups and channels did before.
- Telegram pictures and files load again in the long-running daemon: a fresh connection no longer counts as silent for hours and gets reset in a loop (an mtcute quirk, worked around until it is fixed there).
- A picture whose Telegram connection never comes up now fails after the download deadline instead of showing its spinner for good, and the daemon log says why a fetch failed.
- A long message folded behind "Show more" no longer leaves an empty stretch under it: the fold now keeps one height whatever the width, so a list row and its content agree.
- The window opens its menus at once when you come back to it: the conversation list is reloaded only when the index or the settings changed, and loading it no longer reads every message of every chat (about half a second less).
- The window no longer freezes when it is activated: the duplicate scan compared every pair of thousands of rows, and now compares only rows that share a word.
- The merge assistant no longer offers deleted Telegram accounts (all named "Deleted Account") or any name that many contacts share as possible duplicates.
- The conversation list showed only the newest chats: mail threads shared its 500-row limit, so a few hundred newsletters pushed every Telegram contact and group but a handful out of the list. Chats are now listed whole and mail has its own limit.
- A picture or file whose download stalls (a dead Telegram connection, say) no longer leaves its tile on a spinner for many minutes: after 45 seconds without a byte the tile offers a retry.

- Telegram: a refused reaction now says why (Premium needed, for example in Saved Messages) instead of a bare RPC error.
- A saved attachment the sender gave no name (a voice note) is named after its type, such as `voice-note-1.ogg`, instead of `attachment`.
- An agent reading your own Saved Messages no longer gets an access prompt: a person with addresses on several networks counts as you when any of them is yours, and a chat with nobody else in it needs no approval.
- The Telegram follow no longer goes deaf after its first catch-up: the catch-up closed the client that carries the update stream, so voice notes and messages sent later arrived only after a restart.
- Sending a file over XMPP failed at the upload slot, because the server's `slot` answer was read as if it were named like the request.
- Sending to Signal failed with "invalid signature detected", because the server's unpadded base64 lost its last byte when decoded.
- `.deb` and `.rpm` no longer carry the test bundles that were left in `dist/` by the test run.
- The `.deb` and `.rpm` are for x86_64 only now, because they carry the native libraries the app loads.
- A chat whose newest page held a picture album stopped loading older messages after that page, because the album's pictures were counted as one message
- A Signal group whose name is not known yet no longer shows its members' IDs as the title; it reads *Unnamed group · 5 members*.
- Files under `/tmp` could not be sent through the daemon ("cannot be read"), because its unit gave it a private `/tmp`. A send now hands the daemon the opened files instead of their paths, so the daemon needs no access to them. Restart it after updating: `systemctl --user restart curlew-daemon`.
- Pictures and files of chat messages synced before 0.2 showed only a blank *Attachment* tile.
  The sync now walks the history of Telegram and Matrix chats again, ten chats and five pages
  per chat per run, and writes only the attachment descriptors; messages, read state and edits
  stay as they are. A message the network no longer shows with an attachment keeps the plain
  tile without a download.
- Opening a video or file from a chat or mail bubble no longer stops at 25 MB; the window may
  fetch up to 100 MB, since a phone video is often bigger than the limit meant for agents.
- German: the refusal for a bad Matrix event id no longer carries a stray second sentence, and one command hint addressed you as "Sie" instead of "du".

### Changed

- A voice note or audio part no longer sits in a card of its own inside the bubble: the bubble is the surface, with the play button, the seek bar, the time and the save button laid out straight in it. A message made only of media (picture, gallery, clip, voice note, file without a caption) now shows its reaction chips in a row under the bubble, on the bubble's side, instead of inside it; bubbles with text keep them inside, and the timestamp stays in the bubble.
- Ordinary email can be switched off per mail account: on the account page (and on the Delta Chat page of the welcome screen) "Show ordinary email" off lists only the threads Delta Chat can talk, in the list, the search, the CLI and MCP. It beats the global "Show all emails", turns Delta Chat on for that account, and switching it back on restores every mail, because nothing is deleted. Protocols has the same "Show ordinary email" row for all accounts, and its text says how many accounts differ. In `config.json` the list `deltaChatAccounts` becomes `mailAccounts` (`{ "<id>": { "deltaChat": true, "plainMail": false } }`); the old key is still read and rewritten on the next save.
- A mail thread whose peer sent the Delta Chat marker is now shown as "Delta Chat" (own badge, tooltip, contact page, merge dialog, new-conversation picker); ordinary mail stays "Mail". A merged contact reads "Delta Chat · XMPP" instead of "Mail · XMPP", and one address with both appears once as Delta Chat. Pins and routes stay on Mail. The email-chat hint now explains why a contact switches from Mail to Delta Chat.
- Switching an account off now pauses it, for every protocol including mail: its conversations and search hits disappear from the window, the CLI and MCP, nothing is synced, nothing is sent and no notification comes. Nothing is deleted, and switching it on again brings everything back without a new login. The switch reads "Use this account" and asks first, naming how many conversations will be hidden. A send from a paused account is refused with a clear message.

- The version lives in one place, `app/package.json`; the About dialog, `curlew --version` and the MCP server handshake read it from there instead of each carrying a copy.
- `npm run packaging:install` takes `--no-icons` and `--remove-icons`, so a stale installed icon no longer shadows the one in `app/data` during development.
- The README describes the messenger and is short; the per-protocol, command-line, daemon, MCP and release details moved to `docs/guide/`. The package metadata and the Flathub listing text describe the messenger, not a mail tool. The first release is `0.2.0`.
- The old project name is gone from the code and docs: only `CURLEW_*` environment variables and the `curlew/` data and config directories are read, and the secret stores use `curlew.*` namespaces and a `curlew-<account>` crypto store name.
- On Windows and macOS the app offers the chat protocols only: no mail backend, no GNOME Online Accounts, no mail group in Accounts, no Delta Chat welcome page and no "Show all emails" switch. One predicate, `chatOnly` in `app/src/core/platform.ts`, decides it. The package descriptions no longer promise mail, contacts and calendar through GOA only.
- "Show all emails" is off by default: the list shows only email chats (mail from Delta Chat compatible clients) and the replies to them, so Curlew reads like a messenger. A config file that sets `ui.showAllEmails` keeps its value; switch it on in Preferences, Conversations, to see every mail thread.
- `dev/screenshots.sh` renders from the demo mode (`CURLEW_DEMO=1`) instead of its own fixture index, and adds group, empty-accounts and all-off motifs; `CURLEW_DEMO_QUIET=1` omits the demo notice. File names: `docs/screenshots/README.md`.

- A new Delta Chat mail message now has the subject `Message from <name>` (Delta Chat spec 0.37, name = the part of the account address before the `@`) instead of `Chat: <first words>`, so a plain mail client no longer shows the start of the chat text.
- Protocol badges are coloured now (Telegram blue, WhatsApp green, Signal blue, Matrix dark with green, XMPP orange, Mail purple) instead of neutral symbols; our own drawings, not the official logos.
- New app icon: a fluffy curlew chick in the messenger bubble, with a matching symbolic icon.
- The style (system, light, dark) is a segmented control in the preferences instead of three circles.
- The message field grows with what is typed, up to five lines. Enter sends, Shift+Enter breaks the line.
- The date separator is a pill of its own, the hints above the composer (room banner, reply, edit, attachments) have padding inside their cards, and the voice player stops at a readable width.
- Group chats show the sender's profile picture next to the name (Telegram, Matrix, WhatsApp). Messages of one sender sit closer together than the first message of a new one, the section headers of the list are quieter, the voice player has padding inside its card, and the contact page picks the name from a combo row.
- A merged person shows a profile picture in the list now: the newest chat's, where its network can serve one.
- Sender names above grouped messages use the accent colour, and a message bubble stops at a readable width on a wide window.
- The conversation view is calmer: "Show more" sits on its own line under a long message instead of covering its text, an empty conversation says so, bubbles are easier to tell apart from the background in dark mode, and the unread count in the list is bold in the accent colour.
- The primary colour tints the window more strongly, so the blue no longer reads as another grey.
- Message bubbles and the composer are opaque, so the background doodles no longer shine through, and your own messages use the accent colour. The default accent is now teal instead of blue.
- The message box of a conversation floats over the history as a rounded card, like Telegram's, and the messages scroll beneath it. [ADR 0013](docs/adr/0013-appearance.md)
- The message menu no longer offers what the chat cannot do: no reactions in Telegram's Saved Messages, and no edit or delete on Signal messages older than a day (the note to self is exempt).
- Mail accounts of the system are read through `@gjsify/system-accounts` instead of Curlew's own GNOME Online Accounts code. A Flatpak without access to them now reports none instead of failing.
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

- The message field has an emoji button that opens GTK's emoji chooser and inserts the emoji at the cursor, in every protocol's thread; it is hidden while the field is read-only.
- The Protocols page has a "Delta Chat" row next to "Mail": off until a mail account is opted in, a dialog asks for which accounts, the subtitle counts them, and it is greyed with the reason while Mail is off.
- Signal: Curlew now sends files into a chat a `signal.send` grant names. The file is encrypted on this computer, uploaded to Signal's file server and sent as an attachment; the text becomes its caption. The protocol table and ADR 0010 say so.
- A test fails when the root `package.json`, a workspace package or the newest metainfo release disagrees with the version the app reports.
- Read receipts for Delta Chat threads: a message you send asks the peer to confirm reading, and a receipt from them shows as the read tick on the message. *Send read receipts* in Preferences (off by default) lets Curlew confirm to them when you open their conversation; it answers only a request from the sender itself, once per message. Receipts that Delta Chat encrypts cannot be read here.
- The AppStream metadata carries brand colours and display and input requirements, and `docs/release/flathub-checklist.md` lists what is left for Flathub.
- `CURLEW_WINDOW_OPEN_WELCOME=<page>` opens a single page of the welcome screen (for example `delta-chat`); the screenshot script gained the motifs `welcome-delta-chat` and `email-chat`.
- Delta Chat threads get a record button in the composer: a voice message is recorded (Ogg/Opus), shown as a chip and sent as a voice note; a received sticker without text shows as a bare picture without a bubble.
- With ordinary mail hidden, the empty conversation list and the Delta Chat welcome page say so and name the "Show all emails" switch.
- A mail thread with a Delta Chat peer (one that sent `Chat-Version`) can answer one message: *Reply* in the bubble menu threads it by `In-Reply-To`. Such a thread shows a *Forwarded from …* mark on a message that opens with Delta Chat's `---------- Forwarded message ----------` line. Ordinary mail threads offer neither (#294).
- XMPP: a reaction, an edit or a delete for everyone is offered in a chat only when the other client advertises it (XEP-0444, 0308, 0424), so a peer without support no longer gets stray messages (#317).
- Delta Chat threads can edit and delete your own messages (`Chat-Edit` / `Chat-Delete` mails). Plain mail never gets them. The index schema moves to version 21, so mail folders with email chats are fetched once more.
- In a Delta Chat thread you can react to a message with an emoji. Curlew sends it as a reaction mail (RFC 9078) and shows the reactions of others on their message; an empty reaction takes the earlier one back. Ordinary mail threads get no reactions. Mail folders with email chats are fetched once more to learn the reaction mails.
- Delta Chat voice notes and stickers: mail from a Delta Chat peer with `Chat-Voice-Message` shows as a voice message with the player and its `Chat-Duration`, a sticker as an image. Sending writes the headers (`Chat-Voice-Message: 1`, `Chat-Duration` in milliseconds, `Chat-Content: sticker`) only for email chats, never for plain mail. Recording in the composer is not part of this change.
- An XMPP account's page has a *Require encryption* switch: nothing is sent from it in plain text, and a message to someone without OMEMO fails instead (`config.encryption`, ADR 0006 §7). Before, this was only possible by editing the config file. Every config key now has a place in the window or is documented as file-only (`docs/design/ui.md`, held by a test).
- The window asks each conversation, not each backend, what it can do (reaction, edit, delete, reply, files). A mail thread offers chat features only when the other side speaks Delta Chat; nothing changes for other chats yet (ADR 0015, #294).
- The welcome screen now walks through protocols, accounts, Delta Chat (one switch per mail account, off by default), AI features (off by default) and a summary. Nothing is forced; skipping leaves everything off.
- A mail account's page and the first email chat explain what an email chat is, once per account and dismissible. "Show all emails" now says it only filters the list.
- Every design pack has its own chat background: leaves for Forest, moon and stars for Dusk, a beach for Sunrise, hearts for Rose, calm geometry for Graphite. Each can be chosen on its own too.
- The conversation search finds people by name, phone number, address or handle as well as by message text. A row that matched a number shows it under the name. A menu next to the search field narrows the search to *Names and numbers* or *Messages*, and the choice is remembered (`ui.searchScope`).
- Demo mode: `CURLEW_DEMO=1 curlew window` (or `curlew demo`) opens the window on made-up data — 23 chats over all six protocols with reactions, edits, replies, threads, an album, a voice note, a video, files and a long mail — for screenshots, tests and trying Curlew without accounts. The data is generated into `$XDG_CACHE_HOME/curlew-demo` (`CURLEW_DEMO_DIR` changes it); your real index, config and accounts are never read, nothing is sent and the daemon is not contacted. The window title and a short notice say so.
- A group has its own page, like a contact: tap its picture in the chat header. Give it a name and picture of your own, a design, accent colour and chat background, and see its protocol, account, member count, Matrix room facts and known members.
- A welcome screen opens on the first start, when there is no account and it was not finished or skipped before: a short introduction, then a page to add accounts. *Welcome* in the main menu opens it again; `CURLEW_WINDOW_OPEN_WELCOME=1` opens it for screenshots. People who already have accounts never see it on their own.
- Mail accounts send ordinary mail by default: the Delta Chat chat marker is added only when you switch on *Use for Delta Chat* on the account's page.
- AI features can be switched off in the preferences (`ui.ai` in the config file), and are off for a new configuration. Off means `curlew mcp` refuses to start (and serves no tools), every agent request is denied, and the Agent access menu item is hidden. A configuration that already has agent rules or grants and no `ui.ai` keeps working as on.
- Protocols can be switched on and off in the Accounts dialog (the gear button): an off protocol is not started by the background service and its chats leave the list, while accounts and history stay. Switching one on for the first time shows its terms.
- `dev/screenshots.sh` renders every listing screenshot (EN/DE × light/dark) from a synthetic demo; the window gained `CURLEW_WINDOW_OPEN_ACCOUNTS`, `CURLEW_WINDOW_OPEN_WELCOME` (reserved) and `CURLEW_NO_HOST_ACCOUNTS` for it.
- Design packs (Curlew, Forest, Dusk, Sunrise, Rose, Graphite) set the primary colour, accent colour and chat background together; the background now sits with the colours in the preferences and has two new patterns, dots and waves.
- A chat can have its own colours and background: pick a design, an accent colour or a pattern on the contact page.
- A contact page opens from the picture in a chat's header. A person combined from several chats sees which chats they are and picks whose name and picture to show, and any contact can get a picture of their own. None of this touches the address book.
- WhatsApp chats and contacts show their profile picture in the list.
- XMPP contacts show the picture from their vCard in the list.
- Matrix rooms and direct chats show their profile picture in the list.
- Telegram chats show their profile picture in the list. The daemon fetches the pictures over one connection and keeps them for a week; without a daemon, or for a chat with none, the initials stay.
- The preferences have a Style row (follow the system, light, dark) and a primary colour that tints the window, header, sidebar and dialogs; the accent colour joins it with the same colour dots and an on/off switch.
- A quiet doodle pattern behind the messages of a conversation, drawn in the text colour at low opacity so it suits light and dark; switch it off under Appearance in the preferences. [ADR 0013](docs/adr/0013-appearance.md)
- An Appearance group in the preferences with an accent colour: Curlew's own blue by default (it follows the system accent only on request), the nine Adwaita colours, or "follow the system". [ADR 0013](docs/adr/0013-appearance.md)
- A Matrix room with only you in it counts as your own chat: sending to it needs no grant. The member list is asked from the homeserver each time, and anything unclear (an error, a pending invite, somebody else) counts as not yours.
- `conversations_get` lists the attachments of a chat message (kind such as voice or image, size, duration, and whether `message_save_attachment` can fetch it), so an agent can find and save a voice note. The filename shows only with `include_bodies`.
- A Signal group shows its name. Curlew reads it from Signal's group service when a message arrives in the group (a read-only fetch for groups you belong to; `backends.signal.settings.groupNames: false` turns it off).
- A mail account no longer needs GNOME Online Accounts. *Add Account → Mail* asks for an address and a password, finds the servers the way Thunderbird does (HTTPS only), asks for them only when nobody publishes them, and proves the login before it saves anything. The password lives in a file of its own (0600) and in no config, log or error. This is how mail works in the Flatpak. GNOME Online Accounts stay a shortcut where they exist.
- A Flatpak. CI builds it from the same bundle as the packages and starts it once inside the sandbox; it has network and display access and nothing else, so mail, contacts and calendar from GNOME Online Accounts stay a feature of the host build.
- Inside a Flatpak the daemon's message notifications go through the Notification portal; outside nothing changes.
- A reply to a message older than the loaded page shows its quote too, and a click on the quote loads the history back to that message
- The list search also finds text inside chat messages and mail subjects (from two characters on); a matching conversation shows the line that matched
- Each conversation in the list shows its newest message under the name, like Fractal and Telegram: *You: …* for your own, the sender in a group, the subject for mail. The account moves into the row's tooltip
- A *New conversation* button above the list opens your address book: pick a contact with an XMPP or mail address and write the first message, on the most trusted protocol they can be reached on. A contact you already talk to opens that conversation instead. Signal, WhatsApp and Telegram follow once a phone number can be resolved to an account
- A first mail to someone no longer gets the subject *Re: Chat*
- A person with no history starts on the most trusted protocol they can be reached on: XMPP and Matrix, then Signal, Telegram, WhatsApp; mail only when it is the sole way
- Your own messages show a check mark once the other side has read them, on the networks that report it. In a quote the author is tinted with the accent colour.
- Links in chat messages are clickable, and a little Markdown is styled: `**bold**`, `*italic*`, `~~strike~~` and `` `code` ``. A link shows its own address; text that does not match stays as typed.
- Pictures and videos in a chat run to the edge of their bubble, like in Fractal and Telegram, instead of sitting in a frame; copy, save and open-with moved into one menu in the viewer.
- WhatsApp direct chats can edit and delete your own messages from the window: *Edit* on a text message, *Delete* for everyone on any of yours. Groups stay read-only.
- Signal direct chats can edit and delete your own messages from the window: *Edit* on a text message, *Delete* for everyone on any of yours. Groups stay read-only.
- XMPP chats can edit and delete your own messages from the window (XEP-0308 corrections, XEP-0424 retractions). An end-to-end encrypted chat refuses both, since they go out unencrypted.
- Telegram chats can edit and delete your own messages from the window: *Edit* on a text message, *Delete* for everyone on any of yours.
- Matrix rooms without encryption can edit and delete your own messages from the window: the bubble menu on a text message offers *Edit*, and *Delete* removes any of your messages for everyone. Encrypted rooms refuse both.
- Telegram chats can send reactions: your emoji replaces your earlier one, and taking it back clears it.
- XMPP chats can send reactions: your emoji replaces your earlier one, and taking it back clears it. An end-to-end encrypted chat refuses them, since a reaction cannot be encrypted.
- Matrix rooms without encryption can send reactions too: a new emoji replaces your earlier one on that message, and taking it back redacts it.
- Reactions from the window: the bubble menu (long press, right click) offers an emoji row, and a tap on a chip gives that emoji or takes your own back. Signal and WhatsApp direct chats can send them; the other networks follow.
- The daemon and its callers can now carry a reaction (send protocol 5). Nothing sends one yet; after updating, restart the daemon with `systemctl --user restart curlew-daemon`.
- Reactions that arrive on a chat message show as small emoji chips under it, with a count when several people gave the same one. Signal, WhatsApp, Matrix, XMPP and Telegram (as counts) deliver them for now.
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
