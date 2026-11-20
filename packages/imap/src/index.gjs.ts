/**
 * GJS entry for @curlew/imap. Keep the exported surface identical to index.node.ts.
 *
 * The two entries differ only in the transport: `openTlsStream` is the one socket opener
 * (Gio), which the caller hands to the backend and to the mail functions (ADR 0018).
 */

export { searchMail, getMessage, listFolders, listParts, fetchPart, type MailSource } from './messages.ts';
export { ImapBackend } from './backend.ts';
export { openTlsStream } from './transport.gjs.ts';
export { ImapClient } from './client.ts';
export { isOwnMailAddress } from './own-address.ts';
export { contentTypeFor, readAttachments } from './attachments.ts';
export { MAIL_MANIFEST } from './manifest.ts';
export { isOwnAccountId } from './own-accounts.ts';
export { fileSentCopy, providerFilesSentMail, sentCopyWarning } from './sent-copy.ts';
export type { SentFolderSession, SentCopyFiler, SentCopyOutcome } from './sent-copy.ts';
