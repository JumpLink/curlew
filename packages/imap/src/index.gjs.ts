/**
 * GJS entry for @curlew/imap. Keep the exported surface identical to index.node.ts.
 */

export { searchMail, getMessage, listFolders, listParts, fetchPart } from './messages.gjs.ts';
export { ImapBackend } from './backend.gjs.ts';
export { MailSender, openMailSender } from './send.ts';
export { MAIL_MANIFEST } from './manifest.ts';
