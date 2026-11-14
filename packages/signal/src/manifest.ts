/**
 * The manifest of the Signal backend.
 *
 * Pure data in its own file: the registry reads it BEFORE it constructs the backend, so the
 * terms notice is shown before any Signal code — and the native addon — is loaded.
 */

import { _, type BackendManifest, PLUGIN_API_VERSION } from '@curlew/protocol';

export const SIGNAL_MANIFEST: BackendManifest = {
  name: 'signal',
  displayName: 'Signal (linked device, via libsignal)',
  pluginApi: PLUGIN_API_VERSION,
  // What the NETWORK can do; what curlew does with it is narrower — it reads everything here and
  // writes only a plain-text message into a chat `signal.send` names.
  capabilities: {
    edits: true,
    // Reactions are read and sent (direct chats; curlew sends to no group).
    reactions: true,
    // Sent too: an `EditMessage`, and a `DataMessage.Delete` (direct chats).
    editsOwn: true,
    deletesOwn: true,
    // Quoted replies (sent as `quote`), no threads.
    threads: false,
    readReceipts: true,
    groups: true,
    // Every chat is end-to-end encrypted; this device holds its own identity and session keys.
    e2ee: true,
    subject: false,
    folders: false,
    // `openAttachments` downloads and decrypts a file a person tapped; a granted send encrypts a
    // file, uploads it to the CDN and sends its pointer (`upload.ts`).
    attachments: true,
    attachmentsRead: true,
    replies: true,
  },
  // Signal keeps no server archive: the queue is emptied once a device acknowledged a message,
  // so what curlew stores is the only copy (`state`); the protocol stores are `secret`.
  syncModel: 'delivery-only',
  // @signalapp/libsignal-client is Rust behind N-API with per-platform prebuilds. On GJS it
  // loads through @gjsify/napi; where no prebuild exists, the backend is unavailable.
  native: true,
  // A Signal account is an ACI (a UUID); the phone number is an optional, often hidden, alias.
  addressKinds: ['signal', 'phone'],
  // Sending advances the Double Ratchet in the session file the receive loop has open: the app
  // serialises a send through the receive lease, and refuses while the daemon holds the account.
  sendSharesReceiveState: true,
  terms: {
    // A getter: this module is evaluated before `initI18n()` on some paths, and a `_()` here
    // would resolve once, in English, for the whole process.
    get summary() {
      return _(
        'curlew connects to Signal as a linked device, like Signal Desktop. It is not an official Signal client and Signal does not support it, so Signal could block it at any time. curlew reads your messages and sends only what you tell it to. Signal keeps no archive: what curlew receives exists only on this device.',
      );
    },
    url: 'https://signal.org/legal/',
  },
};
