# Media grid and silent video preview

Status: piece 1, the duration badge and Telegram albums built; the silent preview open (S6). Reference: Telegram groups several photos and videos sent together into one
bubble with a grid; a single video plays silently, in a loop, while it is on screen, with a
duration badge. Neither exists in curlew yet: today every attachment is its own full-width row.

## Goals

- Several pictures and videos of one message, or of one album, read as one block.
- A video shows its length before it is opened.
- Nothing plays sound unasked, nothing downloads a large file unasked (ADR 0010).

## Three pieces, in this order

### 1. The grid for one message

A message with two or more image or video parts shows them in one grid instead of stacked rows.
This already covers Signal, WhatsApp and mail, whose messages carry several parts.

Layout (Telegram's, in Adwaita terms, drawn in a `Gtk.Grid`-free way so it stays testable):
a pure function `gridLayout(sizes, maxWidth)` returns the rectangles. 1 part: its own ratio.
2: side by side. 3: one wide on top, two below. 4: two by two. 5 and more: one wide on top, then
rows of two or three. Rows have equal height, cells fill the row width, a 2 px gap. The bubble
is at most `BUBBLE_MAX_IMAGE_WIDTH` wide; at 360 px the grid uses the whole bubble.

Parts that are neither image nor video (files, voice) stay below as tiles. More than nine media
parts: the first nine form the grid and the rest list as tiles until the viewer can page through
an album.

Each cell is the existing `inlinePreview` (picture or poster), so loading on scroll, the
spinner and the fall back to a tile on failure all stay. A cell that cannot show a preview (too
big, unsized, or a failed load) stays dark with the play symbol for a video, not a tile of its
own width; pressing it opens the viewer.

### 2. Telegram albums

Telegram sends an album as separate messages that share a `groupedId`. The index needs it:

- `TgMessage.groupedIdUnique: string | null` from mtcute's `Message.groupedIdUnique` (unique across chats).
- `ChatMessage.groupId` in the protocol, `conversation_messages.group_id TEXT` (schema 15, the
  backfill and the regular sync both write it).
- The conversation model folds consecutive messages of one sender and conversation with the same
  non-empty `group_id` into one display entry (`foldAlbums`): the grid of all their parts, each
  tagged with the message it came from, the caption of the one message that has text, the read
  receipt of the last. The FIRST message stands for the entry, so its id and time stay the cursor
  older pages are read before; the album's earlier parts would otherwise load again as rows.
  There is no time rule: the group id is unique per album. Reply, delete and copy act on the message under the press;
  that comes with the quote/reaction work (S7).

`group_id` NULL means "not looked at", `''` "looked, no album"; readers treat both as none. The
regular sync writes `''` for a message without a group. Old rows are NULL: the backfill fills them
in for a network that declares `ChatSession.groupsMedia` (Telegram), also for messages that already
have descriptors. Until then they stay separate rows. Only messages with an attachment are looked
at. Known edge: an album cut by a page boundary shows as two rows until the other page loads.

### 3. Duration badge and silent preview

- Every video cell shows a badge top left with `m:ss` from `duration_ms` (a voice message and
  audio show it too, in their tile). No duration in the index: no badge.
- Silent preview: a video cell that is the only visible part of a bubble and whose file is
  already in the preview cache (so already fetched for the poster) plays muted and looped while
  it is at least half on screen, and stops when it leaves the screen or the window loses focus.
  A small speaker-off symbol sits next to the badge; pressing the cell opens the viewer with
  sound. One preview at a time per window (the one nearest the middle), so a long chat does not
  decode ten streams.
- A setting under Preferences: *Play videos silently in chats* (on by default on the desktop,
  off when the system reports reduced motion via `gtk-enable-animations = false`).

## Out of scope

Server-side thumbnails (Telegram `thumbnails`, Matrix `info.thumbnail_url`), which would show a
poster for videos over 8 MB without downloading them; a carousel between the parts in the
viewer (swiping left and right through an album) — wanted, but its own step after the grid.

## Tests

- `gridLayout`: rectangles for 1 to 10 parts, with portrait, landscape and unsized parts; sums of
  widths equal the row width; no cell below a minimum size.
- Folding: same group and sender fold, another sender, group or conversation does not, a message
  with text keeps its caption, the fold's id is the first one's.
- Store: `group_id` round trip, backfill fills it, schema 14 to 15.
- Screenshot: the demo index gets a four-part album and a three-part Signal message, English and
  German captions as before.
