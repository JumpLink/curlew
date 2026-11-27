/**
 * The manifest of the WhatsApp backend.
 *
 * Pure data in its own file: the registry reads it BEFORE it constructs the backend, so the
 * terms notice is shown before any WhatsApp code runs — and here that notice matters more than
 * anywhere else in curlew.
 */

import { _, type BackendManifest, PLUGIN_API_VERSION } from '@curlew/protocol';

export const WHATSAPP_MANIFEST: BackendManifest = {
  name: 'whatsapp',
  displayName: 'WhatsApp (unofficial, via Baileys)',
  pluginApi: PLUGIN_API_VERSION,
  // What the NETWORK can do. The frontends read these to show or hide a feature; curlew only
  // reads, so none of this is a promise that curlew can SEND it.
  capabilities: {
    edits: true,
    // Reactions are read and sent (direct chats; curlew sends to no group).
    reactions: true,
    // Sent too: an `edit` and a revoking `delete` of the person's own message (direct chats).
    editsOwn: true,
    deletesOwn: true,
    // Replies, but no threads or topics.
    threads: false,
    // Sending read receipts (MessageSender.readReceipt) is not implemented; receiving read marks is separate.
    readReceipts: false,
    // The per-chat mute arrives with the chat reports (`muteEndTime`) and is written with `chatModify`.
    mutes: true,
    pins: true,
    groups: true,
    // Every chat is end-to-end encrypted (Signal protocol); this device holds its own keys.
    e2ee: true,
    subject: false,
    folders: false,
    // `openAttachments` downloads and decrypts a file a person tapped; the sender uploads one.
    attachments: true,
    // A recording goes out as the network's voice note where it has one (Ogg Opus mono, see
    // probeMediaFile), else as an audio file.
    voiceNotes: true,
    attachmentsRead: true,
    // Asked on the receiver's own connection (a second login would collide with it).
    avatars: true,
    replies: true,
  },
  // No server archive: a message is gone from WhatsApp's servers once a device acknowledged it.
  // What curlew stores is the only copy (`state`); the auth state is `secret`.
  syncModel: 'delivery-only',
  // Baileys is JavaScript plus a WASM module — no native addon, no per-platform prebuilds.
  native: false,
  addressKinds: ['whatsapp', 'phone'],
  // WhatsApp allows one connection per linked device, and a send writes the libsignal sessions in
  // the same auth-state file the receive loop has open, with nothing locking between them: the app
  // serialises a send through the receive lease and refuses while the daemon holds the account.
  sendSharesReceiveState: true,
  terms: {
    // A getter: this module is evaluated before `initI18n()` on some paths, and a `_()` here
    // would resolve once, in English, for the whole process.
    get summary() {
      return _(
        "Curlew connects to WhatsApp as a linked device through Baileys, an unofficial client. This violates WhatsApp's Terms of Service, so WhatsApp can ban your phone number, temporarily or for good. Enable it only if you accept that risk. Curlew reads your messages and sends only what you tell it to. WhatsApp keeps no archive: what Curlew receives exists only on this device.",
      );
    },
    url: 'https://www.whatsapp.com/legal/terms-of-service',
  },
};
