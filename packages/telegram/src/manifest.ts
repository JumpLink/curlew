/**
 * The manifest of the Telegram backend.
 *
 * Pure data in its own file: the registry reads it BEFORE it constructs the backend, so the
 * terms notice is shown before any Telegram code runs.
 */

import { _, type BackendManifest, PLUGIN_API_VERSION } from '@curlew/protocol';

export const TELEGRAM_MANIFEST: BackendManifest = {
  name: 'telegram',
  displayName: 'Telegram (official API via mtcute)',
  pluginApi: PLUGIN_API_VERSION,
  // What the NETWORK can do, as far as cloud chats go. The frontends read these to show or hide
  // a feature. curlew sends plain text only, behind `telegram.send`, so none of this is a promise
  // that curlew can SEND it.
  capabilities: {
    // True, but by a different route than Matrix and XMPP: Telegram has no edit feed, so
    // `fetchHistory` never reports one. `getHistory` returns each message's CURRENT text, and an
    // edit changes neither the id nor the date, so it only reaches the index when a full scan
    // re-reads the window and rewrites the row. Asserted end to end in telegram.test.ts
    // ("delivers an edited message") so this cannot outlive the mechanism.
    edits: true,
    // Reactions are read (counts per emoji, see map.ts) and sent (one per person).
    reactions: true,
    // Sent too: `messages.editMessage`, and a revoking `messages.deleteMessages`.
    editsOwn: true,
    deletesOwn: true,
    // Forum topics in supergroups only (map.ts sets `threadRemoteId` for topic messages). A plain
    // reply chain is `replyToRemoteId`, not a thread.
    threads: true,
    // Sending read receipts (MessageSender.readReceipt) is not implemented; receiving read marks is separate.
    readReceipts: false,
    // The per-chat mute is read from the dialog list and written with `account.updateNotifySettings`.
    mutes: true,
    groups: true,
    // Cloud chats are encrypted client–server only. Secret chats (end-to-end) are out of scope,
    // so claiming E2EE here would be false.
    e2ee: false,
    subject: false,
    folders: false,
    // `openAttachments` downloads a photo, file or voice note a person tapped; the sender uploads
    // one file per message the person picked in the window.
    attachments: true,
    attachmentsRead: true,
    // `openAvatars` fetches the small profile picture of a chat for the list.
    avatars: true,
    replies: true,
  },
  // Telegram keeps the full history of cloud chats: the index is rebuildable (`derived`).
  // The session file with the auth key is not — it is `secret`, and kept apart from the index.
  syncModel: 'server-archive',
  native: false,
  addressKinds: ['telegram', 'phone'],
  terms: {
    // A getter, not a plain property: this module is pure data evaluated the moment anything
    // imports it, which on some paths is before `initI18n()` has run — a `_()` here would resolve
    // once, in English, and keep that answer for the whole process. Reading `terms.summary` is
    // what every frontend already does, so nothing else changes.
    get summary() {
      return _(
        "Curlew connects to Telegram as a third-party client through the official API, using the API credentials of Curlew's own registered app. You can use your own instead when you log in. An account that misuses the API can be limited or banned by Telegram. Curlew reads your chats and sends only what you tell it to.",
      );
    },
    url: 'https://core.telegram.org/api/terms',
  },
};
