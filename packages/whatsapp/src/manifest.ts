/**
 * The manifest of the WhatsApp backend.
 *
 * Pure data in its own file: the registry reads it BEFORE it constructs the backend, so the
 * terms notice is shown before any WhatsApp code runs — and here that notice matters more than
 * anywhere else in curlew.
 */

import { type BackendManifest, PLUGIN_API_VERSION } from '@curlew/protocol';

export const WHATSAPP_MANIFEST: BackendManifest = {
  name: 'whatsapp',
  displayName: 'WhatsApp (unofficial, via Baileys)',
  pluginApi: PLUGIN_API_VERSION,
  // What the NETWORK can do. The frontends read these to show or hide a feature; curlew only
  // reads, so none of this is a promise that curlew can SEND it.
  capabilities: {
    edits: true,
    // The network has reactions; map.ts drops them in extractContent/message.
    reactions: false,
    // Replies, but no threads or topics.
    threads: false,
    // Delivered/read/played receipts, per message.
    readReceipts: true,
    groups: true,
    // Every chat is end-to-end encrypted (Signal protocol); this device holds its own keys.
    e2ee: true,
    subject: false,
    folders: false,
    // hasAttachments metadata only; no attachment download in receiver.ts.
    attachments: false,
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
    summary:
      "curlew connects to WhatsApp as a linked device through Baileys, an UNOFFICIAL reimplementation of the WhatsApp Web protocol. It is not an official WhatsApp client, and using it violates WhatsApp's Terms of Service: WhatsApp can ban the account — your phone number — temporarily or for good, and does so with accounts it sees using unofficial clients. Enable this only if you accept that risk for this number. curlew reads your messages, and writes only where you granted it: it sends a plain-text message into a chat a `whatsapp.send` grant names, and nothing else — no read receipts, no typing indicator, no online presence, no attachments (it does acknowledge delivery, as every linked device must). WhatsApp keeps no server archive, so what curlew receives exists only in its local index, and WhatsApp unlinks a device that has not connected for about 14 days.",
    url: 'https://www.whatsapp.com/legal/terms-of-service',
  },
};
