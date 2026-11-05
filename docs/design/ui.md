# Curlew UI rules

The rules every Curlew window follows. Order of authority: **minimal and
[GNOME HIG](https://developer.gnome.org/hig/) first**; macOS patterns only where they complement
the HIG; on a conflict the HIG wins.

Curlew is one app for every messenger. The UI is therefore organised by **function**, never by
protocol.

## Role models

Read-only checkouts under `refs/` (Fractal, Flare) and in the gjsify tree (Tuba). Each pattern
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

## Responsive

A window is an `Adw.NavigationSplitView` (sidebar plus content) with an `Adw.Breakpoint`. At
**720 sp and narrower** the split view collapses to one pane: the list, and a selected entry
pushes the content pane with the automatic back button. The window's minimum width is **360 px**
(Phosh, phones). Nothing may need a wider window: rows ellipsize, chips wrap
(`Adw.WrapBox`), and segmented controls get their own line.

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
- The protocol is secondary: a small badge on the avatar and a filter chip. Nothing else.

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

## Main window: one combined list

All contacts, channels and groups of every messenger in **one** list.

- Sections (collapsible): People, Groups; later Favourites and Channels.
- **Filters are toggle chips** (`pill`, plus `suggested-action` while on), not tabs: one per protocol, shown only when there is a choice; once a
  protocol is chosen, one per account of it, if it has several.
- Row: avatar with protocol badge (the protocol is shown ONLY there, never as text), title with a
  short time right-aligned, a subtitle line with the unread marker at its end. The subtitle is a
  one-line preview of the last message (Fractal, Flare) once the index stores one; until then it
  names the account.
- Unread has three tiers: an **accent count** (a mention), a **grey count** (unread), a **dot**
  (activity without a count); the title is bold while unread.
- Future: grouping one person across messengers by hand. A separate ADR; the leaning is that
  Curlew stores the link itself and never writes the address book without confirmation.

### Built and not built

Built: the list, sections, chips, search, badges, the grey count with bold title, the empty state.

Not built, future work: the **accent count** and the **dot**. The index keeps one `unread_count`
per conversation; a mention and activity-without-count need the backends to store that state in
the index first. Until then only the grey tier exists.

Also not built: the **last-message preview**. The index keeps the time (`last_message_at`, shown) but
no preview text on the conversation row; chat bodies sit in `conversation_messages` and mail bodies
only in the FTS table, so a preview needs a per-conversation column filled at sync time.

Protocol badges are 16 px themed Adwaita symbolic icons on a solid 22 px circle (the `card` style class: it contrasts in light and dark mode) that hangs on the avatar's lower-right rim so the initials stay readable; one distinct icon per protocol (mail:
envelope, XMPP: server, Signal: shield, Matrix: globe of nodes, Telegram: paper plane, WhatsApp:
phone), with a tooltip naming the protocol.
The protocols' logos have their own trademark licences, so Curlew ships none.

## Conversation view (documented, not built)

Header: title and a one-line subtitle or topic. History: day separators, system events collapsed
into one expandable line ("3 room changes"), reaction chips, stacked read-receipt avatars.
Composer: attach, emoji, a rounded entry, a more-menu, a round accent send button. The window
shows a placeholder until the backends' send paths are wired to it.

## Agent access is not a main area

It is a permission policy, not something one does all day. It lives in the primary menu as
**Agent access**, which opens a dialog (the HIG's place for app-wide settings). The three-way
choice (allow, ask, deny) is an `Adw.ToggleGroup`: three or four fixed options, all visible at
once, which a dropdown would hide.

## Screenshots and metadata

Flathub's quality guidelines apply to every listing: English first screenshot, a German one
tagged `xml:lang`, default settings, the window alone, at most 1000×700 logical, synthetic demo
content (`example.org`), a one-sentence caption without a full stop. Shots are taken with
`scripts/headless-run` against a temporary config and a temporary synthetic index, never the
real ones.
