/**
 * Node entry for @curlew/imap. Keep the exported surface identical to index.gjs.ts.
 */

export { searchMail, getMessage, listFolders, listParts, fetchPart, ImapBackend } from './unavailable.ts';
export { ImapClient } from './client.ts';
export { isOwnMailAddress } from './own-address.ts';
export { contentTypeFor, readAttachments } from './attachments.ts';
export { MAIL_MANIFEST } from './manifest.ts';
export { isOwnAccountId } from './own-accounts.ts';
export { fileSentCopy, providerFilesSentMail, sentCopyWarning } from './sent-copy.ts';
export type { SentFolderSession, SentCopyFiler, SentCopyOutcome } from './sent-copy.ts';
