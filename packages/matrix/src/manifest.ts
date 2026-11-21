/**
 * The manifest of the Matrix backend.
 *
 * Pure data in its own file: the registry reads it BEFORE it constructs the backend.
 */

import { type BackendManifest, PLUGIN_API_VERSION } from '@curlew/protocol';

export const MATRIX_MANIFEST: BackendManifest = {
  name: 'matrix',
  displayName: 'Matrix (matrix-js-sdk, Rust crypto as WebAssembly)',
  pluginApi: PLUGIN_API_VERSION,
  // What the NETWORK can do, not what curlew does with it. Curlew reads, and with a
  // `matrix.send` grant sends `m.room.message`s, files, edits, reactions and redactions — in a
  // clear room over plain HTTP, in an encrypted one through the daemon's live client, which is
  // the only process holding the crypto store (ADR 0019). No threaded send. A room that asks for
  // encryption is never sent to in the clear: without a daemon such a send is refused (send.ts).
  capabilities: {
    // `m.replace` relations.
    edits: true,
    // `m.annotation` relations, received and sent (a removal is a redaction).
    reactions: true,
    // Sent too: an `m.replace` event to edit, a redaction to delete.
    editsOwn: true,
    deletesOwn: true,
    // `m.thread` relations (and reply chains everywhere).
    threads: true,
    // Sending read receipts (MessageSender.readReceipt) is not implemented; receiving read marks is separate.
    readReceipts: false,
    groups: true,
    // Megolm rooms are end-to-end encrypted, and this backend decrypts them where it holds the
    // room key (see the package's README section in AGENTS.md for which history that is).
    e2ee: true,
    subject: false,
    folders: false,
    // Both ways, clear or encrypted: `openAttachments` downloads an `mxc://` file a person
    // tapped (decrypting it where the event carried a key), and a send uploads one to the media
    // repository — the ciphertext in an encrypted room — and posts it as `m.image`/`m.file`.
    attachments: true,
    attachmentsRead: true,
    // A room's or a direct chat's picture, as a thumbnail from the homeserver.
    avatars: true,
    replies: true,
  },
  // The homeserver keeps the room history: the index is rebuildable (`derived`). The crypto
  // store (the device's Olm account and the room keys it received) is not — it is `secret`,
  // and kept apart from the index in the account's secret file.
  syncModel: 'server-archive',
  native: false,
  addressKinds: ['matrix'],
  // An encrypted send writes the crypto store the receive path has open — the Megolm session it
  // creates or rotates, and the one-time keys it spends. Two processes in that store wipe each
  // other (ADR 0019 §1), so the app routes a send to the daemon holding the account instead of
  // opening a second client. A clear room needs none of it, but the route is per account, not
  // per room, and asking the daemon costs one call that is answered `not-followed` at worst.
  sendSharesReceiveState: true,
  // Matrix is an open protocol with a client-server API meant for third-party clients; the only
  // terms are the ones of the homeserver the user already has an account on.
  terms: null,
};
