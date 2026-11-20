/**
 * The mail backend with its send port. Lives behind the `@curlew/imap/send` entry, so the SMTP
 * stack (`@curlew/smtp`, nodemailer, `node:net`/`node:tls`) is in the import graph only of an app
 * that sends (ADR 0018). A read-only build registers `ImapBackend` and never loads this file.
 */

import type { MessageSender, SendBackend, SendPermit } from '@curlew/protocol';
import { ImapBackend } from './backend.ts';
import { openMailSender } from './send.ts';

export class ImapSendBackend extends ImapBackend implements SendBackend {
  /**
   * The send port (ADR 0004, amended 2026-10-30): SMTP through GOA, behind a `mail.send` permit.
   * The permit is checked again on every send; this method reads no password.
   */
  async openSender(accountId: string, permit: SendPermit): Promise<MessageSender> {
    return openMailSender(
      accountId,
      permit,
      (raw, id) => this.fileSent(accountId, raw, id),
      (_to, folder, uids) => this.markSeen(accountId, folder, uids),
    );
  }
}
