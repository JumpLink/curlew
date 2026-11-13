/**
 * The manifest of the built-in mail backend.
 *
 * Pure data in its own file so both entry points export it: the registry reads a manifest
 * BEFORE it constructs a backend (a terms notice must be shown before any code of the backend
 * runs), and on Node the backend itself is only a stub.
 */

import { type BackendManifest, PLUGIN_API_VERSION } from '@curlew/protocol';

export const MAIL_MANIFEST: BackendManifest = {
  name: 'mail',
  displayName: 'Mail (IMAP)',
  pluginApi: PLUGIN_API_VERSION,
  capabilities: {
    edits: false,
    reactions: false,
    editsOwn: false,
    deletesOwn: false,
    threads: true,
    readReceipts: false,
    groups: true,
    e2ee: false,
    subject: true,
    folders: true,
    attachments: true,
    attachmentsRead: false,
    replies: true,
  },
  syncModel: 'server-archive',
  native: false,
  addressKinds: ['email'],
  // Your own mailbox, with an account you added here or in GNOME Settings — nothing to warn about.
  terms: null,
};
