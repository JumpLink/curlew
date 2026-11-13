# Curlew UI rules

The rules every Curlew window follows. Order of authority: **minimal and
[GNOME HIG](https://developer.gnome.org/hig/) first**; macOS patterns only where they complement
the HIG; on a conflict the HIG wins.

Curlew is one app for every messenger. The UI is therefore organised by **function**, never by
protocol.

## Role models

Read-only checkouts under `refs/` (Fractal, Flare, Paper Plane, Dino, Hylki, Convey) and in the gjsify tree (Tuba). Each pattern
below names the file it comes from.

| Pattern | From | Where |
|---|---|---|
| `Adw.NavigationSplitView` with `collapsed` driven by the window | Fractal | `src/session_view/mod.blp` (`split_view`, bound to the window's `compact`) |
| `Adw.Breakpoint` collapsing the split view; sidebar 300–400 px, fraction 0.25 | Flare | `data/resources/ui/window.blp` (`max-width: 720sp`) |
| Rows: `Adw.Avatar` plus title plus unread marker | Flare | `data/resources/ui/channel_item.blp` |
| Unread as count or dot in one `Gtk.Stack`; small avatar | Fractal | `src/session_view/sidebar/room_row.blp` |
| Collapsible sections that show a count or dot while collapsed | Fractal | `src/session_view/sidebar/section_row.blp` |
| Sidebar header with only search and a menu | Fractal | `src/session_view/sidebar/mod.blp` |
| `Adw.ToggleGroup` as a filter | Tuba | `src/Widgets/ProfileFilterGroup.vala` |
| Split view plus breakpoint plus navigation in one window | Tuba | `src/Dialogs/MainWindow.vala` |
| Settings in an `Adw.PreferencesDialog` with switch rows | Flare | `data/resources/ui/preferences_window.blp` |
| History: day dividers, message rows, reactions, read receipts, typing, title | Fractal | `src/session_view/room_history/` (`divider_row`, `message_row`, `read_receipts_list`, `typing_row`, `title.blp`) |
| Composer: attach, emoji, entry, send | Fractal | `src/session_view/room_history/message_toolbar/` |
| Attachment bubbles: photo, picture, document with transfer state, reply quote | Paper Plane | `src/ui/session/content/message_row/` (`photo.blp`, `media_picture.blp`, `document/`, `reply.blp`) |
| Send-media sheet: preview before sending, caption | Paper Plane | `src/ui/session/content/send_media_window.blp` |
| File input and upload overlay in the composer | Dino | `dino/main/data/` (`file_input_widget.ui`, `file_send_overlay.ui`, `file_default_widget.ui`) |
| Accounts: add, per-account subpage, picker row | Dino | `dino/main/data/preferences_window/` (`add_account_dialog.ui`, `account_preferences_subpage.ui`), `account_picker_row.ui` |
| Accounts page for several providers | Hylki | `src/ui/accounts.rs`, `src/ui/cloud_accounts.rs` |

## Responsive

A window is an `Adw.NavigationSplitView` (sidebar plus content) with an `Adw.Breakpoint`. At
**720 sp and narrower** the split view collapses to one pane: the list, and a selected entry
pushes the content pane with the automatic back button. The window's minimum width is **360 px**
(Phosh, phones). Nothing may need a wider window: rows ellipsize, filters sit in a popover
instead of a bar, and segmented controls get their own line.

## macOS as layout inspiration only

Take: source-list sidebar, slim header bar (search and menu only), segmented controls
(`Adw.ToggleGroup`) instead of dropdowns for small fixed choices, generous spacing, inspector-style
detail panes.

Do not take: traffic lights, foreign fonts, custom CSS that fights Adwaita. Dark mode, accent
colours and the Flathub quality rules must keep working, so Curlew ships no stylesheet for
structure; it uses Adwaita's style classes.

## Organised by function, not protocol

- A feature that exists in more than one messenger gets **one** control in **one** place. It is
  defined first in `@curlew/protocol`, then implemented per backend.
- The UI asks **capabilities** (the manifest's `capabilities`, `SenderFeatures` in
  `packages/protocol/src/backend.ts`), never "is this Signal?".
- A missing capability **hides** the control. No greyed-out controls, no per-protocol special
  views. Where a limit needs explaining (an encrypted Matrix room that cannot be sent to yet), a
  short hint sits at the composer.
- The protocol is secondary: a small badge on the avatar and an entry in the filter popover.
  Nothing else.

Shared controls, an open list: emoji picker (one for reactions and the composer; custom emoji and
stickers get their own section only where the backend has them; a backend with one reaction per
person looks the same, a new reaction replaces the old), reaction chips, replies, forwarding,
edit and delete, read receipts, typing, presence, attachments, the profile view, and later calls
(one call button and one call view, whatever the technology).

## Profile view: per person

One view per **person**, not per account: avatar, name, status, and every way to reach them with
protocol badges. One **Verify** section with the same three states, whatever the mechanism:
*verified*, *blindly trusted*, *untrusted* (Signal safety number, OMEMO fingerprint, Matrix
cross-signing). Shared media, common groups and mute live in the same place. Groups and channels
get the same view: topic, members, settings.

**Built so far** (`contact-page.ts`, an `Adw.Dialog` opened from the avatar in the chat header): the
hero picture and name, "Combined from N chats", the Name and Picture choices for a merged
contact (an *Automatic* row plus one row per part), a picture of their own for any direct
contact, and *Separate* for a merge made by hand. Verify, shared media and common groups are
still open. The note to self has no page. A **group** opens the same dialog titled *Group*: a name
the person types, a picture of their own, an *About* block (protocol, account, member count, and
for Matrix public/encrypted when the homeserver said so, plus the member names the index holds)
and the same Look rows. No pin, merge or separate action: a group has none of them. Each Look
pick is saved and applied to the open chat behind the dialog at once (live preview); the list and
header are rebuilt when the dialog closes. Preferences already applied each pick immediately.

## Main window: one combined list

All contacts, channels and groups of every messenger in **one** list.

- Sections (collapsible): People, Groups; later Favourites and Channels.
- **Filters live in a popover**, not tabs: a `view-filter-symbolic` menu button in the sidebar
  header opens toggles under *Protocols* and, for each chosen protocol with several accounts, a
  group of account toggles under that protocol's name, plus **Clear filters**. An account choice
  narrows only its own protocol; deselecting a protocol drops its account choices. The button is
  shown only when there are two protocols or an account choice to make.
- **Note to self**: a chat with one's own account is titled *Note to self* and gets a composer.
  Recognised where the index tells positively (Signal, Telegram, XMPP, Matrix, WhatsApp); mail
  is not. WhatsApp reads the own JIDs from `accounts.address`, which a sync or daemon run fills
  from the stored session; with none known the chat stays an ordinary one.
- **Matrix rooms** get a composer targeting the room id. A line above it reads "Public room · N
  members" or "Room · N members", only once the homeserver said both; an unknown is left out. A
  room known to be encrypted keeps the composer disabled with the reason shown instead.
- **Direct mail is grouped by person**: every direct mail thread with the same person is one
  row. Chat backends are not regrouped, their conversations already are one per person.
- **Show all emails** (Preferences, off by default). Off, the list keeps only mail threads that
  carry the chat marker (`Chat-Version`, see below) and the replies to them, so the window reads
  like a messenger beside the mail client.
- Row: avatar with protocol badge (the protocol is shown ONLY there, never as text), title with a
  short time right-aligned, a subtitle line with the unread marker at its end. The subtitle is a
  one-line preview of the newest message (Fractal, Flare): the first non-blank line, "You: …"
  for your own, "Name: …" in a group, the subject for mail, "Attachment" for a file alone. A row
  with no message yet names the account; with a preview, the account moves to the row's tooltip.
- Unread has three tiers: an **accent count** (a mention), a **grey count** (unread), a **dot**
  (activity without a count); the title is bold while unread.
- Future: grouping one person across messengers by hand. A separate ADR; the leaning is that
  Curlew stores the link itself and never writes the address book without confirmation. The
  concept — merged rows, the protocol picker, pins — is [`contacts.md`](contacts.md).

### Built and not built

Built: the list, sections, the filter popover, search, badges, the grey count with bold title,
the empty state, grouping by person, the Preferences dialog.

Not built, future work: the **accent count** and the **dot**. The index keeps one `unread_count`
per conversation; a mention and activity-without-count need the backends to store that state in
the index first. Until then only the grey tier exists.

**Search** looks at names, numbers and message text, and a menu button next to the entry narrows
it: *Everything* (default), *Names and numbers*, *Messages*; the choice is kept in `ui.searchScope`
(`all`, `names`, `messages`). Names are the row title and every participant name; numbers are the
participants' addresses. A phone query ignores spaces, dashes and brackets and the leading `+`,
`00` or `0`, so `+49 151 123`, `0049 151 123` and `0151 123` find the same chat (the match is on
the digits, not on country codes). A handle matches with or without `@`. A row that matched a
number or a name other than its title shows that field as its subtitle. From two characters on
the scope also reads the text of chat messages and the subject of mail (`searchMessageText`, a
`LIKE` over `conversation_messages`, newest match per conversation); a row that matched by text
shows the matching line instead of the newest message. Names and numbers are matched in memory on
the rows the list already holds; only the message text goes to the index. Mail rows follow
`ui.showAllEmails` as before, so chats and mails are searched together only when all mail is shown.
Known limits: SQLite folds only ASCII case ("ä" does not find "Ä"), and mail bodies live in the
full-text index and are not searched here, except the body of an unsent draft (a mail in a folder with the `drafts` role); a merged chat-and-mail search is contacts.md question 6.
`CURLEW_WINDOW_SEARCH=<text>` opens the search with that text and `CURLEW_WINDOW_OPEN_SCOPE=1` also
opens the scope menu, for screenshots.

The preview is read from `conversation_messages` by the window alone (`latestMessagePreviews`, the
first 300 characters of the newest body) and kept on the `ListEntry`; the `Conversation` DTO that
agents get stays free of bodies. Mail keeps its body in the full-text index, so a mail row shows the
subject. Not built: per-type labels ("Photo", "Voice message") instead of "Attachment".

Protocol badges are 16 px coloured round icons (our own `curlew-protocol-<backend>` SVGs in
`app/data/protocol-icons`, see `PROTOCOLS.md`) on a solid 22 px circle (the `card` style class: it contrasts
in light and dark mode) that hangs on the avatar's lower-right rim so the initials stay readable;
one colour and glyph per protocol (mail: purple envelope, XMPP: orange cross, Signal: blue ring,
Matrix: green `[m]`, Telegram: blue plane, WhatsApp: green handset, Delta Chat: red bubble with envelope flap), with a tooltip naming the
protocol, so colour never carries the meaning alone. Delta Chat is not a backend: `carrierOf()` (`app/src/core/visibility.ts`) shows a mail thread as Delta Chat when its peer sent the chat marker (per thread, so a contact flips from Mail to Delta Chat once the marker arrives; the thread hint says so). Pins and routes stay on `mail`. The Protocols page lists Delta Chat as a derived row (on = at least one opted-in mail account, greyed while Mail is off). The drawings are inspired by, not copies of,
the protocols' trademarked logos, and imply no endorsement.

## Conversation view

Built: a header with the title and the protocol as subtitle; a history of bubbles (`card`, own
messages right-aligned, the time at the bubble's foot, "Contains attachments" when there are
some) with a day separator between days; a mail subject only where the topic changes, so an
email chat reads like a chat; a composer (a rounded entry and a round accent send button,
`mail-send-symbolic` + `circular`) shown only when the conversation has a reply target. A
failed send stays in the entry and shows a toast. In a group, the first bubble of a run from one
sender carries the sender's name and a small initials avatar (not for own messages or direct
chats). A message with only attachments shows their kind and file name where the index has them
(mail), else "Attachment".

**Mail attachments** (mail only; chat backends keep the "Attachment" line). A picture of a known
raster type up to 12 MB is shown in the bubble (`Gtk.Picture`, scaled down to 420 × 300, an
`Adw.Spinner` while it loads); any other part, and a picture that fails to load, is a tile: a
themed icon from the MIME type, name, size, and Open / Save as… (a video's primary button is
Play). Parts stack vertically above the text; a message with no written text hides its body.
Clicking a picture opens the **viewer**, an overlay over the split view (as in Fractal) with
Back, Save, Copy and Fullscreen; Escape closes it, F11 toggles fullscreen, a video uses
`Gtk.Video`'s own controls. No carousel, zoom or animation. The bytes are not in the index: a
picture is fetched when it nears the screen, any other part on a click, through the same
`mailSaveAttachment` as the CLI, into `$XDG_CACHE_HOME/curlew/previews` (`CURLEW_PREVIEWS_DIR`).
That cache is message content, so the window empties it at start. Not built: SVG, audio in the
viewer, thumbnails decoded off the main thread, screen-reader labels beyond the tooltips.

**Emoji in the composer.** A flat round smiley button sits right of the field (tooltip and accessible
label "Insert emoji"); it opens `Gtk.EmojiChooser` as a popover and inserts the pick at the cursor,
then returns focus to the field. Emoji are plain text everywhere, so every protocol's thread has it;
it is hidden when the composer is read-only. The bubble menu keeps its six quick reactions
(`QUICK_REACTIONS`): a reaction row is a one-tap choice, and not every protocol accepts any emoji
as a reaction (Telegram allows a fixed set), so the full chooser is not offered there.
Screenshot hook: `CURLEW_WINDOW_OPEN_EMOJI=1`.

**Voice notes and stickers** (Delta Chat threads only). The composer shows a record button next
to the paperclip when the thread offers `voiceNotes` (a mail thread whose peer sent
`Chat-Version`; the manifest flag is the upper bound). It records Ogg/Opus through GStreamer
(PulseAudio, else PipeWire) into `$XDG_CACHE_HOME/curlew/previews/voice`, shows the running time,
and a second click turns the recording into a chip; under half a second is dropped, five minutes
is the limit. A lone recording goes out as `Chat-Voice-Message` with `Chat-Duration`; next to
other files it is an ordinary attachment. A received voice note uses the player; a received
sticker (`Chat-Content: sticker`, flagged `sticker` on the attachment, no schema change) with no
text is a bare picture without a bubble. Not built: sending stickers, pause/resume, waveform.

**History is paged** (Fractal's rule). The pane opens on the newest 50 messages and scrolls to
the end; when the scroll position comes within two viewports of the top (`value < page_size * 2`)
it reads the next older 50, with an `Adw.Spinner` row on top meanwhile, until a page comes back
short. The cursor is `(sent_at, id)`, strictly older than the oldest message shown — a total
order, so equal timestamps neither repeat nor skip, and a message without a time sorts as the
oldest. The new rows go in front a few per idle turn, and every growth of `upper` is added to
`value`, so what the person reads does not move. Day separators and subject labels are computed
over everything shown, so the seam between two pages is corrected, not duplicated. A newer
conversation cancels a running page load.

**A quote reaches past the loaded pages.** A reply whose target is older than what is loaded is
looked up by network id (`getMessagesByRemoteId`, chat rows only) as each page arrives, so the
quote block shows even then. A click on it pages back, 50 at a time, until the real row is built
and scrolls to it; if the history runs out first, a toast says the message is no longer there.
`exhausted` counts the raw page, not the album-folded list: a page of 50 rows that folds to 47
bubbles is still a full page.

**A long body fades** (Tuba's "Show More"). `FadeBin` clamps its child to 300 px when it would be
taller than 400 px and fades the last 125 px with a gradient alpha mask; a `pill opaque` "Show
more" button over the foot lifts the clamp. A label is still laid out in full under a clamp, so
`bubbleText` also cuts a body at 1500 characters / 30 lines until the button is used, which is
what keeps the pane from freezing on a long history.

Sending from the window is the person's own action (ADR 0008), so it asks no grant. A mail account sends
**email chats** after Delta Chat's convention only when the person switched on *Use for Delta Chat* on its
account page (`deltaChatAccounts` in the config, off by default); otherwise it sends ordinary mail. An email chat has: a `Chat-Version: 1.0` header, a generic
subject (`Message from <sender name>` per Delta Chat spec 0.37, or `Re: <subject>` when answering ordinary mail) and normal `In-Reply-To`/`References` threading, so any mail
client still shows a readable thread. The index records the marker on receipt (`email_chat`),
which is what *Show all emails* filters on. No encryption yet (curlew#145). A received message whose body is
encrypted (Delta Chat sends every message as OpenPGP `multipart/encrypted`) is flagged `encrypted` by the sync
from its BODYSTRUCTURE; its bubble reads *Encrypted message: it cannot be shown here* instead of *No text body*.

Not built: system events collapsed into one expandable line ("3 room changes"), reaction chips,
stacked read-receipt avatars, attach, emoji and the more-menu in the composer.

## Agent access is not a main area

It is a permission policy, not something one does all day. It lives in the primary menu as
**Agent access**, which opens a dialog (the HIG's place for app-wide settings). The three-way
choice (allow, ask, deny) is an `Adw.ToggleGroup`: three or four fixed options, all visible at
once, which a dropdown would hide.

The item only shows while AI features are on. The switch is the **AI features** row in Preferences
(`ui.ai`); off, every agent request is denied and `curlew mcp` serves nothing. An unset `ui.ai` is
off, except in a config that already has agent rules, grants or switches (`aiEnabled` in
`app/src/core/config.ts`).

## Every setting has a place

Nothing a person may sensibly change needs the config file. `app/src/window/settings-map.ts` lists
every config key and where it is changed; its types follow `UiConfig` and `CurlewConfig`, and
`settings-map.test.ts` holds the list against `parseConfig`, so a new key without a place fails.

| Key | Place |
|---|---|
| `ui.showAllEmails`, `ui.notifications`, `ui.playVideosSilently` | Preferences: Conversations, Notifications, Media |
| `ui.accentColor`, `primaryColor`, `colorScheme`, `chatBackground` | Preferences: Appearance |
| `ui.ai` | Preferences: AI (Agent access in the menu only while on) |
| `ui.searchScope` | Conversation list, search scope |
| `backends.<name>.enabled`, `termsAcceptedAt` | Accounts: Protocols |
| `disabledAccounts` | Account page: Sync this account |
| `deltaChatAccounts` | Account page (mail): Use for Delta Chat; Accounts: Protocols: Delta Chat |
| `encryption` | Account page (XMPP): Require encryption (whole account; single-peer entries stay file-only) |
| `agentAccess`, `grants` | Agent access dialog |
| `mergedPeople`, `declinedMerges`, `pins`, `contactChoices` | Contact page, merge assistant, protocol picker |
| `ui.welcomeDone`, `ui.emailChatHintSeen`, `unknown` | State the app keeps; no row |

File-only on purpose: `senders` (`curlew conversations classify`) and `backends.<name>.settings`
(a backend's own non-secret options).

## About dialog

`Adw.AboutDialog`, opened from the header menu. It shows the app icon and ID, the version, the
developer (JumpLink / Pascal Garber, as in the metainfo), the copyright, the AGPL-3.0 licence, the
website and the issue tracker. The version comes from `app/src/core/version.ts`, which reads
`app/package.json`, the same source as `curlew --version`; a unit test keeps the metainfo release
and every `package.json` on that number.

## App icon

The app icon follows the GNOME HIG for app icons; how it came about, round by round, with every
overview and contact sheet: [`app-icon/README.md`](app-icon/README.md).

## Screenshots and metadata

Flathub's quality guidelines apply to every listing: English first screenshot, a German one
tagged `xml:lang`, default settings, the window alone, at most 1000×700 logical, synthetic demo
content (`example.org`), a one-sentence caption without a full stop.

One script renders all of them, EN/DE × light/dark, against a private synthetic index and config
in `/tmp/curlew-demo-shots` (never the real ones), under `scripts/headless-run`:

```bash
dev/screenshots.sh --build            # all motifs → docs/screenshots/<motif>.<lang>.<scheme>.png
dev/screenshots.sh --only accounts --lang de --scheme dark
dev/screenshots.sh --check            # only verifies that every expected file exists
# file names and the Flathub set: docs/screenshots/README.md
```

Motifs: `conversations`, `conversation` (c1, Alex Weber), `conversation-narrow` and
`conversations-narrow` (360×740), `contact`, `preferences`, `accounts`, `protocols`, `agent-access`, `welcome`, `welcome-delta-chat`, `email-chat`.

The window reads these environment variables (all in `app/src/window/main.ts`):
`CURLEW_WINDOW_OPEN=<conversation id>` (`c3` is the email chat, `c5` an XMPP chat),
`CURLEW_WINDOW_FILTER`, `CURLEW_WINDOW_SIZE=WxH`, `CURLEW_WINDOW_QUIT_AFTER_MS`,
`CURLEW_WINDOW_OPEN_CONTACT=1`, `CURLEW_WINDOW_OPEN_PREFERENCES=1`, `CURLEW_WINDOW_OPEN_ACCESS=1`,
`CURLEW_WINDOW_OPEN_ACCOUNTS=1`, `CURLEW_WINDOW_OPEN_PROTOCOLS=1` and `CURLEW_WINDOW_OPEN_WELCOME=1`,
`CURLEW_DEBUG_STALL=1` (logs every main-loop stall over `CURLEW_DEBUG_STALL_MS`, default 50, and the timing of the list refresh),
which opens the first-run welcome screen (`app/src/window/welcome.ts`; pages listed in
`welcome-model.ts`; shown once, tracked by `ui.welcomeDone`). Pages: intro, protocols, accounts, Delta Chat (one switch per mail account, off by default, text from `email-chat-model.ts`), AI (off by default) and a summary; no page forces an input, skipping keeps the safe defaults. The email-chat hint (`Adw.Banner` above a thread, once per account in `ui.emailChatHintSeen`) shows only where the other side sent `Chat-Version`; "Show all emails" is a list filter only. On Windows and macOS (`chatOnly()` in `app/src/core/platform.ts`) the welcome screen has no Delta Chat page and no mail wording, Accounts has no mail group, Preferences no "Show all emails". `CURLEW_NO_HOST_ACCOUNTS=1` hides the
host's GNOME Online Accounts, so the Accounts dialog never shows real ones. The language comes from
`LC_ALL`/`LANG`/`LANGUAGE`, which the script sets. A smaller `--size` cuts off the window shadow.

For a quick look without the script, `CURLEW_DEMO=1 curlew window` (or `curlew demo`) opens the window on
the same kind of synthetic data (`app/src/core/demo/`), generated into `CURLEW_DEMO_DIR` (default
`$XDG_CACHE_HOME/curlew-demo`). A demo window is titled "Curlew (demo)" and shows a notice once (`CURLEW_DEMO_QUIET=1` omits it; the screenshot script sets it).

## Chat backgrounds

Every design pack has its own quiet tile behind the messages: Curlew the doodles, Forest leaves, trees
and mushrooms, Dusk moon, stars, clouds and a penguin, Sunrise sun, palm, waves and a crab, Rose hearts,
petals and flowers, Graphite plain geometry. Tiles are one colour at 10 % opacity, follow light/dark
and the accent, and repeat seamlessly. The person can pick any pattern separately (preferences, or per
chat). Mascot licences: ADR 0013, amendment of 2026-11-12.
