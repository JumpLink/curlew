# ADR 0017 — media thumbnails at sync

- **Status:** Proposed (2026-11-16)
- **Scope:** `@curlew/protocol` (`ChatAttachment`), `@curlew/store` (schema v25, `chat-sync.ts`,
  `attachments.ts`, `chat-backfill.ts`), every chat backend, `app` (window bubble, preview cache).
  Extends [ADR 0010](0010-attachments-across-protocols.md) (one descriptor, one handle,
  "only a small picture fetches").

## Context

ADR 0010 §3 says the window fetches on its own only images ≤ 2 MB and, to show a first frame,
videos ≤ 8 MB. Everything bigger shows a dark box with a play symbol until the person taps it. A
holiday video is 40 MB, so in practice a chat of videos is a chat of dark boxes, and the person
cannot tell which one is which without paying for every one.

The networks already ship a preview with the message, at sync, for free: WhatsApp puts
`jpegThumbnail` bytes in the message, Telegram sends `thumbs` (a `PhotoStrippedSize` inline plus
downloadable sizes), Matrix names `info.thumbnail_url` (`thumbnail_file` in an encrypted room),
Signal's pointer carries a `thumbnail` pointer and a `blurHash`. XMPP and mail usually ship none.
`ChatAttachment.thumbnail?: Uint8Array` is already in the ADR 0010 text, capped at 8 KiB — but
no backend writes it, the store has no column for it, and no one reads it.

## Decision

### 1. Thumbnail bytes are a file in the preview cache, not a column

`message_attachments` gains **three small columns**, never the bytes:

```sql
-- v25, additive
thumb_handle TEXT,   -- backend-private, fetch the network's thumbnail later; NULL = none offered
thumb_state  TEXT,   -- NULL = not looked at, 'none', 'stored', 'failed'
blur_hash    TEXT    -- ≤ 40 chars, the only pixels allowed in the index
```

Inline bytes that arrive with the message are written at sync into the **preview cache** as
`<previews>/<part-key>/thumb.jpg` (`part-key` as the full-file cache already keys it), and
`thumb_state` becomes `'stored'`. Reasons: the index is `state` and backed up, a thumbnail is
`derived`; a BLOB per attachment would grow the index by the size of a thumbnail gallery; and the
cache is already private (0700) with an eviction policy ([`preview-cache-model.ts`](../../app/src/window/preview-cache-model.ts)).

- **Cap: 16 KiB per thumbnail** (ADR 0010's 8 KiB is below Telegram's and WhatsApp's real sizes).
  Larger inline bytes are dropped, not re-encoded; `thumb_state = 'none'`.
- A thumbnail is **never deleted by eviction** while its message exists: `pickEvictions` skips
  `thumb.jpg` and counts only full files. 16 KiB × everything is still small next to one video.
- Emptying the previews directory at window start (ADR 0010 §6) would throw them away, so the
  **thumbnails move to a sibling directory, `thumbsDir()`, which is not emptied**. It is still
  `derived`: deleting it costs a re-sync of posters, nothing else.

### 2. A handle when the network makes us ask

Where there are no inline bytes but a thumbnail is fetchable (Telegram's larger `thumbs`, Matrix's
`thumbnail_url`, Signal's thumbnail pointer), sync writes only `thumb_handle` and leaves
`thumb_state` NULL. The window then fetches **that handle, not the file**, when the bubble scrolls
into view — unconditionally, because a thumbnail is tens of kilobytes, through the same
daemon-or-direct path as `fetchAttachment`. On success `'stored'`, on failure `'failed'` and one
retry per window run. An XMPP `https://` link is never prefetched (ADR 0010 §3 stands).

### 3. Protocol types

```ts
interface ChatAttachment {
  // …as today
  thumbnail?: Uint8Array;   // inline bytes shipped with the message, ≤ 16 KiB
  thumbHandle?: string;     // backend-private; fetch a small preview without the full file
  blurHash?: string;        // the network's own, never computed by curlew
}
```

`AttachmentInfo` (store → window) gains `thumbPath: string | null` and `blurHash: string | null`.
The two handles stay inside `@curlew/store` exactly as `handle` does: no DTO, no MCP output, no log.
MCP's `conversations_get` reports `hasThumbnail: boolean` and nothing else — a thumbnail is a
picture of somebody's words.

### 4. Per-backend mapping

| Backend | Inline | Handle | blurHash |
|---|---|---|---|
| WhatsApp | `jpegThumbnail` (typically 2–10 KiB) | — | — |
| Telegram | `PhotoStrippedSize` (inflated with the standard JPEG prefix/suffix) | the largest `thumbs` entry under 16 KiB | — |
| Matrix | — | `info.thumbnail_url`; in an encrypted room `thumbnail_file` plus its keys | — |
| Signal | — | the pointer's `thumbnail` | `blurHash` from the pointer |
| XMPP | none (a `jpeg-thumbnail` hint exists in the wild; not in scope) | — | — |
| mail / Delta Chat | none — mail parts are fetched by IMAP section anyway | — | — |

A backend that has none writes nothing; `thumb_state` stays NULL and the bubble behaves as today.

### 5. Poster precedence in the window

`showsPoster` stops being a size test and becomes: **cached full file > stored thumbnail >
blurHash > dark box**. `AUTO_FETCH_VIDEO_MAX_BYTES` disappears — a video is no longer fetched
whole to get a frame, which also removes an unasked 8 MB download. `AUTO_FETCH_IMAGE_MAX_BYTES`
stays for images, with the thumbnail shown underneath until the full picture arrives.

A blurHash renders as the 4×3 gradient it is, behind the play symbol: it tells dark from bright,
nothing more. We render the ones Signal sends and **never compute one ourselves** — encoding a
hash means decoding the full file first, which is what this ADR is avoiding.

### 6. Privacy

A thumbnail of an encrypted message is plaintext at rest. That is not a new line crossed: the
index already holds bodies ([AGENTS.md](../../AGENTS.md), `0600`), and a thumbnail is less than
the body it belongs to. It stays *outside* the index as `derived`, mode 0700, so nothing in the
backup set grows, and `curlew` offers no command that prints one. The write log never names it.
A deleted message deletes its thumbnail in the same transaction as its rows (`chat-sync.ts`
already deletes `message_attachments`); a deleted conversation likewise.

### 7. Backfill

Rows with `thumb_state` NULL and a video or image `kind` are candidates. `backfillAttachments`
already walks history for rewindable sessions and writes descriptor rows; it writes thumbnails in
the same pass, bounded by the same `BACKFILL_CHATS`/`BACKFILL_PAGES`. Telegram, Matrix and XMPP
are rewindable, so their old videos gain posters over a few syncs. WhatsApp and Signal keep no
archive, so pre-v25 rows there keep the dark box forever — the same trade ADR 0010 §2 took.

### 8. Tests

- Pure: `showsPoster` precedence (file / thumb / hash / none), the 16 KiB cap, the stripped-JPEG
  inflation, `pickEvictions` never dropping a `thumb.jpg`.
- Store: v24 → v25 upgrade on a populated fixture; thumbnail file removed with its message row;
  `thumb_state` transitions; `AttachmentInfo.thumbPath` null when the file is gone but the row says
  `'stored'`.
- Backends: synthetic fixtures only (a 1×1 JPEG), one per mapping row, asserting bytes-or-handle.
- No real network media in any fixture.

## Consequences

- **Index v25**, additive, three nullable columns. An older curlew refuses it as always.
- One new cache directory with its own lifetime rule (not emptied at start) — `doctor` and
  `privacy/data-tiers.md` list it.
- Videos stop being downloaded whole for a frame: less traffic, and no accidental read receipt
  from fetching 8 MB.
- Each backend's mapping is one PR, as in ADR 0010; the window change lands once, before them, and
  degrades to today's behaviour while no backend writes a thumbnail.

## Alternatives considered

- **BLOB column in `message_attachments`:** simplest reader, but it puts pixels in the backed-up
  `state` tier and grows the index without bound.
- **Compute our own thumbnails on fetch:** needs the full file, which is the problem.
- **Compute a blurHash locally:** same objection.
- **Keep the 8 MB auto-fetch as a fallback when no thumbnail exists:** it is an unasked download
  the person did not choose; the dark box is honest.
- **One `thumbnails` table keyed by message:** a second table for three nullable columns on a
  table that is already keyed the same way.

## Open questions

- Whether `thumbsDir()` should survive a cache purge by the desktop (it is under `$XDG_CACHE_HOME`;
  a cleaner may delete it, and the answer is a re-sync, not a crash).
- Telegram's stripped-size inflation needs the real JPEG tables verified against gramjs before the
  first mapping PR.
