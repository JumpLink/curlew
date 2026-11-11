/**
 * Node entry for @curlew/imap. Keep the exported surface identical to index.gjs.ts.
 */

export { searchMail, getMessage, listFolders, listParts, fetchPart, ImapBackend } from './unavailable.ts';
export { isOwnMailAddress, MailSender, openMailSender } from './send.ts';
export { contentTypeFor, readAttachments } from './attachments.ts';
export { MAIL_MANIFEST } from './manifest.ts';
export { isOwnAccountId } from './own-accounts.ts';
