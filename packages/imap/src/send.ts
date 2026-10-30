/**
 * The mail backend's send path: one message over SMTP, behind a saved `mail.send` grant.
 *
 * `@curlew/smtp` builds and sends the message; this file decides only what it is allowed to be —
 * which address, from which account, and that the address is one the permit names. The SMTP
 * target comes from GOA (`listSmtpTargets`), so there is no credential in the config, in a log,
 * in a DTO or in an error: the target hands out a thunk, and the password is read when the
 * connection is made.
 *
 * Pure on purpose (no `gi://`): the sender is unit-tested against a loopback dummy server on
 * both runtimes, and GOA/EDS load on first use on both.
 */

import type {
  MessageSender,
  SendPermit,
  SenderFeatures,
  SendingMessage,
  SentMessage,
  SmtpTarget,
} from '@curlew/protocol';
import { listSmtpTargets } from '@curlew/gnome';
import { sendMessage, type SmtpAccount } from '@curlew/smtp';
import { _, fmt } from '@curlew/protocol';

/** `'none'` exists for a loopback dummy server; `@curlew/smtp` allows it on 127.0.0.1 only. */
function smtpAccountFor(target: SmtpTarget): SmtpAccount {
  return {
    host: target.host,
    port: target.port,
    security: target.security,
    username: target.user,
    auth: { kind: 'password', password: target.getPassword() },
  };
}

export class MailSender implements MessageSender {
  /** Mail bodies are plain text: no chat styling, no splitting. */
  readonly features: SenderFeatures = { markdown: false };
  private readonly target: SmtpTarget;
  private readonly permit: SendPermit;

  constructor(target: SmtpTarget, permit: SendPermit) {
    this.target = target;
    this.permit = permit;
  }

  /** The address exactly as the permit spells it, or a refusal — the permit is the second check. */
  private address(to: string): string {
    if (!this.permit.addresses.includes(to)) {
      throw new Error(
        fmt(_('sending to {address} is not granted for account {account}'), {
          address: to,
          account: this.permit.account,
        }),
      );
    }
    return to;
  }

  async send(message: SendingMessage): Promise<SentMessage> {
    const to = this.address(message.to);
    const result = await sendMessage(smtpAccountFor(this.target), {
      from: this.target.from,
      to: [to],
      subject: message.subject ?? '',
      text: message.text,
    });
    return { target: to, id: result.messageId, sentAt: new Date().toISOString() };
  }

  /** Nothing stays open between sends: the transport is closed inside `sendMessage`. */
  async close(): Promise<void> {}
}

/** Open the sender for one account. Reads no password until a message is actually sent. */
export async function openMailSender(accountId: string, permit: SendPermit): Promise<MessageSender> {
  const target = (await listSmtpTargets(accountId)).find((t) => t.accountId === accountId);
  if (!target) {
    throw new Error(
      fmt(_('no mail account {account} with SMTP — `curlew accounts list` shows them'), {
        account: accountId,
      }),
    );
  }
  return new MailSender(target, permit);
}
