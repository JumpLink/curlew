# ADR 0010 — attachments across protocols

- **Status:** Proposed (2026-11-07)
- **Scope:** `@curlew/protocol` (the attachment descriptor, the fetch capability), `@curlew/store`
  (one table, schema v14), every chat backend (`signal`, `whatsapp`, `telegram`, `matrix`, `xmpp`),
  `app` (core action, daemon bus, GTK window, MCP). Builds on
  [ADR 0004](0004-sending-and-writing-granted-per-capability.md) (mail attachments amendment),
  [ADR 0008](0008-grants-restrict-agents-not-the-person.md) and
  [ADR 0009](0009-agent-access-per-account-and-contact.md).

## Context

Only mail handles attachments today. `SenderFeatures.attachments` is true for the SMTP sender
only, the `attachments` table is keyed by a mail row id and an IMAP section, and the window's
`AttachmentInfo.section` says "mail only". Every chat message carries one bit,
`conversation_messages.has_attachments`, and the five chat manifests promise "no attachments".

A messenger without pictures and files is not a messenger, so attachments have to work for all
five chat backends, in both directions, in the window and (under the agent rules) through MCP.
They differ more than text does: a Signal attachment is a CDN pointer plus a key, a WhatsApp one a
media key plus a direct path, Telegram's is a file reference only a live session can resolve,
Matrix's an `mxc://` URI behind an authenticated media endpoint, and XMPP's a plain `https://` (or
OMEMO `aesgcm://`) link. A shared model must hide none of that from the backend and none of it
from the UI that has to show a spinner, a limit and an error.

## Decision

### 1. One descriptor, one opaque handle per backend

`ChatMessage` gains `attachments?: ChatAttachment[]` next to `hasAttachments` (which stays and is
derived from it where the list is present):

```ts
type AttachmentKind = 'image' | 'video' | 'audio' | 'voice' | 'file';

interface ChatAttachment {
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  kind: AttachmentKind;         // from the MIME type, or the network's own label (voice note)
  width: number | null;
  height: number | null;
  durationMs: number | null;
  handle: string;               // opaque to everyone but the backend that wrote it
  thumbnail?: Uint8Array;       // only what the network ships inline, capped at 8 KiB
}
```

The caption is the message's `text`, never a second field. The **handle** is a backend-private
JSON string (Signal: CDN number, key, digest, plaintext length; WhatsApp: media key, direct path,
the two SHA-256s; Telegram: the file reference; Matrix: the `mxc://` URI; XMPP: the URL and, when
OMEMO sent it, the key). It is written once with the message and is only ever given back to the
backend that wrote it. A window, a CLI, an MCP client or a log line never sees it.

### 2. Storage: one additive table, schema v14

```sql
CREATE TABLE IF NOT EXISTS message_attachments (
  message_id TEXT NOT NULL,     -- conversation_messages.id
  idx        INTEGER NOT NULL,  -- position in the message
  kind TEXT NOT NULL, filename TEXT, mime_type TEXT, size INTEGER,
  width INTEGER, height INTEGER, duration_ms INTEGER,
  handle TEXT NOT NULL, thumbnail BLOB,
  PRIMARY KEY (message_id, idx))
```

- Written in the same transaction as the message, once. Chat messages are never rewritten
  wholesale (see the note above `syncChats`), so neither are these rows. An edit does not touch
  them.
- Mail keeps its `attachments` table and its IMAP section. `loadAttachments(db, ref)` is the one
  reader and picks the table by backend, so the window has one code path.
- **Messages indexed before v14 have `has_attachments = 1` and no rows.** They show one generic
  "Attachment" tile that cannot be opened. No backfill: Signal and WhatsApp keep no archive to
  re-read, and a re-sync of the others is not worth an unbounded history walk.
- No message text, filename or thumbnail leaves the index through logs. The write log (ADR 0004
  §7) records name and size of what was *sent*, as for mail, never content.

### 3. Fetching: a read capability, separate from sending

```ts
interface AttachmentFetcher {
  fetchAttachment(account: AccountRef, attachment: FetchableAttachment, sink: ByteSink,
    options: { maxBytes: number; signal?: AbortSignal }): Promise<{ mimeType: string | null; size: number }>;
}
```

- It is a second optional handle on a backend, reached like the sender is (`openAttachments`), and
  declared in the manifest as `capabilities.attachmentsRead`. Sending is `attachmentsSend`
  (`SenderFeatures.attachments`, generalised from mail). A backend may claim one without the other.
- The backend verifies what the network lets it verify before the sink sees the last byte (Signal:
  digest and MAC; WhatsApp: both SHA-256s; the others: the announced size) and throws on mismatch.
  The byte count is capped at `ATTACHMENT_BYTES` (25 MB default, 100 MB max, `limits.ts`) and at
  the manifest's per-protocol limit, whichever is lower.
- One core action, `chatSaveAttachment({ ref, index, directory?, maxBytes?, agent? })`, writes
  through the existing `FileSink` with `safeFileName`, into the private attachments directory.
  The window, `curlew` and MCP all call it.
- **Where it runs follows the send rule.** The daemon owns live sessions, and Telegram's and
  WhatsApp's must have one writer (the lease of [ADR 0002](0002-receiving-daemon.md) §4, see `app/src/core/actions/send.ts`). So a fetch is handed to the
  daemon over the session bus when the daemon holds the account (`daemon-bus.ts`, a new method,
  `DAEMON_WIRE_VERSION` bumped), and runs directly otherwise. A daemon that holds the account and
  cannot be reached refuses, as send does. The result is a path inside the daemon's private
  previews directory, never a caller-chosen one.
- **Only the person's own action or a small picture fetches.** The window fetches automatically
  only thumbnails/images up to 2 MB that scroll into view and only for a message that is already
  shown; everything else waits for a tap. Nothing fetches an arbitrary URL on its own: an XMPP
  `https://` link is opened after a tap, never prefetched (it would tell the sender's server that
  and when the person read the message).

### 4. Sending: the person's own action needs no grant; agents do

- **The window** sends attachments from every enabled account (ADR 0008 §1). The file dialog,
  paste or drop is the person's act; no grant, no path check beyond "an absolute regular file the
  person chose".
- **Agents** (MCP, `curlew send --attach`): the grant rules of ADR 0008 §2 apply, plus a **new
  capability per backend, `<backend>.attach`, off unless named**. `<backend>.send` stays text only.
  Reason: `SendingAttachment.path` is an absolute path on the person's disk. An agent that may send
  a text to a friend must not thereby be able to send them `~/.ssh/id_ed25519`. Mail already
  carries attachments under `mail.send` (ADR 0004, amendment 2026-11-05); that stays, and its path
  rules are the model: absolute, regular file, size-capped, name and size logged.
- A message to the person's own address (ADR 0008 §2) still needs no grant, with or without an
  attachment.
- **Receiving by agents follows ADR 0009.** `message_save_attachment` (the chat counterpart of
  `mail_save_attachment`) calls `requireMessageRead` for the message first, so a contact whose read
  mode is `deny` or `ask` is exactly as closed for its pictures as for its text.
- Limits are checked **before** a send starts (sender-side, from the manifest) so a 90 MB video
  to a 2 GB-limit network and a 90 MB video to a 100 MB-limit one differ in the message shown, not
  in a half-finished upload.

### 5. Per-backend facts that decide the order

| Backend | Receive | Send | Notes |
|---|---|---|---|
| Telegram | `downloadAsBuffer` through the daemon's session | `sendMedia` | easiest; first |
| Matrix | `mxc://` via the authenticated media endpoint | upload, then `m.image`/`m.file`/`m.audio` | unencrypted rooms only (encrypted rooms are not supported at all yet; their attachments follow with E2EE) |
| WhatsApp | `downloadMediaMessage` from the stored media keys | Baileys media send | more unofficial-client surface: a ToS decision to be taken before send (see the plan) |
| Signal | pointer → CDN → AES-CBC + HMAC check, curlew's own code | v4 upload form + own encryption | the same upload lifts the "text over 2000 characters is refused" limit |
| XMPP | OOB/`https://` after a tap; `aesgcm://` decrypted with the OMEMO key | XEP-0363 upload + OOB; `aesgcm` when the chat is OMEMO | no plaintext upload into a chat that is OMEMO-encrypted (the rule of ADR 0006 §7: a peer with devices never gets plaintext) |

### 6. The window

- A bubble shows an image preview (from the fetched file or the inline thumbnail while loading), or
  a file tile (icon by kind, name, size), or an audio/voice row. Tap opens the existing viewer or
  "Save as…". The composer gets an attach button, drag-and-drop and paste for images, a preview
  strip with a remove button, an upload state with retry, and the picker's carrier decides which
  protocol limit applies. The attach button is hidden when the chosen carrier cannot send files.
- The window keeps its previews private (0700) and empties them at start, as today.

## Consequences

- **Index v14**, additive; downgrade-safe in the sense that an older curlew refuses the newer
  index with `IndexTooNewError` as for every bump, not by misreading it.
- Every manifest text ("no attachments") is rewritten when its backend gets the capability, in the
  same PR, so the in-app description stays true.
- A new grant capability family (`<backend>.attach`) and the Agent-access page must show it.
- The daemon's bus API grows one method and the wire version moves; a window older than its
  daemon says so instead of failing silently (the wire version already exists for `Send`).
- Old messages keep their generic tile forever. Chosen over a history re-walk (see 2).

## Alternatives considered

- **Reuse the `attachments` table for chats**: it is keyed by an integer mail row and an IMAP
  section; widening both columns would touch every mail query for no gain.
- **Store the downloaded bytes in the index**: it would make the index the size of a media
  library, put message content in a file an agent may read through `sqlite` and break the
  "private per-part directory emptied at start" rule that already holds.
- **Fetch in the window process**: Telegram's session and WhatsApp's keys have one writer
  (ADR 0002 §4); a second process would be the duplicate-session failure the send path already avoids.
- **Let `<backend>.send` include attachments**: simpler, but gives every text-sending agent a file
  exfiltration route (§4).
- **Auto-download everything under a size limit**: a read receipt by another name and a data bill
  on a phone; only small pictures on screen are fetched automatically.

## Work packages

AP1.3 (window reads the descriptor), AP2.1–2.5 (receive per backend), AP4.0 (composer), AP4.1–4.5
(send per backend), AP4.6 (manifests, grants, write log). See the umbrella plan; each is one PR.
