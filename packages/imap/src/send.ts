/**
 * The mail backend's send path: one message over SMTP, behind a saved `mail.send` grant.
 *
 * `@curlew/smtp` builds and sends the message; this file decides only what it is allowed to be —
 * which address, from which account, and that the address is one the permit names. The SMTP
 * target comes from `resolveSmtpTargets` (own accounts, then the system's), so there is no
 * credential in the config, in a log, in a DTO or in an error: the target hands out a thunk, and
 * the password is read when the connection is made.
 *
 * Pure on purpose (no `gi://`): the sender is unit-tested against a loopback dummy server on
 * both runtimes, and the system account store loads on first use on both.
 */

import type {
  MessageSender,
  SendPermit,
  SenderFeatures,
  SendingDeletion,
  SendingEdit,
  SendingMessage,
  SendingReaction,
  SentMessage,
  SmtpTarget,
} from '@curlew/protocol';
import { sendMessage, type SmtpAccount } from '@curlew/smtp';
import { _, fmt } from '@curlew/protocol';
import { readAttachments } from './attachments.ts';
import { resolveSmtpTargets } from './targets.ts';

/** `'none'` exists for a loopback dummy server; `@curlew/smtp` allows it on 127.0.0.1 only. */
async function smtpAccountFor(target: SmtpTarget): Promise<SmtpAccount> {
  return {
    host: target.host,
    port: target.port,
    security: target.security,
    username: target.user,
    auth: { kind: 'password', password: await target.getPassword() },
  };
}

/**
 * Whether `to` is the account's own mail address (`from` of its SMTP target), compared
 * case-insensitively and as a whole: a sub-address, another domain or a display-name form is not it.
 */
export function isOwnMailAddress(from: string, to: string): boolean {
  const own = from.trim().toLowerCase();
  return own.includes('@') && to.trim().toLowerCase() === own;
}

export class MailSender implements MessageSender {
  /** Mail bodies are plain text: no chat styling, no splitting. */
  readonly features: SenderFeatures = {
    markdown: false,
    attachments: true,
    replies: false,
    reactions: true,
    edits: true,
    deletes: true,
  };
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
    // Read (and refused) before the connection exists; the content goes to `@curlew/smtp` only.
    const files = readAttachments(message.attachments ?? []);
    const result = await sendMessage(await smtpAccountFor(this.target), {
      from: this.target.from,
      to: [to],
      subject: message.subject ?? '',
      text: message.text,
      ...(message.emailChat ? { emailChat: true } : {}),
      ...(message.emailChat && message.voiceMessage ? { voiceMessage: true } : {}),
      ...(message.emailChat && message.voiceMessage && message.durationMs !== undefined
        ? { durationMs: message.durationMs }
        : {}),
      ...(message.emailChat && message.sticker ? { sticker: true } : {}),
      ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
      ...(message.references ? { references: message.references } : {}),
      ...(files.length === 0
        ? {}
        : {
            attachments: files.map((f) => ({
              filename: f.filename,
              contentType: f.contentType,
              content: f.content,
            })),
          }),
    });
    return {
      target: to,
      id: result.messageId,
      sentAt: new Date().toISOString(),
      ...(files.length === 0 ? {} : { attachments: files.map((f) => ({ filename: f.filename, size: f.size })) }),
    };
  }

  /**
   * A reaction is a mail with `Content-Disposition: reaction` whose body is the emoji (RFC 9078);
   * an empty body takes the person's reaction back. Only a Delta Chat peer's message is reacted to.
   */
  async react(reaction: SendingReaction): Promise<void> {
    const to = this.address(reaction.to);
    const target = reaction.target.remoteId;
    if (!reaction.target.emailChat || !/^<[^\s<>@]+@[^\s<>@]+>$/.test(target)) {
      throw new Error(_('only a Delta Chat message can be reacted to by mail'));
    }
    await sendMessage(await smtpAccountFor(this.target), {
      from: this.target.from,
      to: [to],
      subject: 'Message from Curlew',
      text: reaction.emoji ?? '',
      emailChat: true,
      reaction: true,
      inReplyTo: target,
      references: [target],
    });
  }

  /** The Message-ID of a message of a Delta Chat peer, or a refusal: nothing else is changed by mail. */
  private changeable(target: SendingEdit['target']): string {
    if (!target.fromSelf || !target.emailChat || !/^<[^\s<>@]+@[^\s<>@]+>$/.test(target.remoteId)) {
      throw new Error(_('only your own Delta Chat messages can be changed by mail'));
    }
    return target.remoteId;
  }

  /** `Chat-Edit`: a mail answering the message, whose body is the new text (never empty). */
  async edit(edit: SendingEdit): Promise<void> {
    const to = this.address(edit.to);
    const target = this.changeable(edit.target);
    if (!edit.text.trim()) throw new Error(_('an edited message cannot be empty'));
    await sendMessage(await smtpAccountFor(this.target), {
      from: this.target.from,
      to: [to],
      subject: 'Message from Curlew',
      text: edit.text,
      emailChat: true,
      chatEdit: target,
      inReplyTo: target,
      references: [target],
    });
  }

  /** `Chat-Delete`: the body is any non-empty text, which the receiver ignores. */
  async delete(deletion: SendingDeletion): Promise<void> {
    const to = this.address(deletion.to);
    const target = this.changeable(deletion.target);
    await sendMessage(await smtpAccountFor(this.target), {
      from: this.target.from,
      to: [to],
      subject: 'Message from Curlew',
      text: 'Message deleted',
      emailChat: true,
      chatDelete: target,
      inReplyTo: target,
      references: [target],
    });
  }

  /** Nothing stays open between sends: the transport is closed inside `sendMessage`. */
  async close(): Promise<void> {}
}

/** The mail backend's `isSelfAddress`: the SMTP target knows the account's own address. */
export async function isOwnAddressOf(accountId: string, to: string): Promise<boolean> {
  const target = (await resolveSmtpTargets(accountId)).find((t) => t.accountId === accountId);
  return target !== undefined && isOwnMailAddress(target.from, to);
}

/** Open the sender for one account. Reads no password until a message is actually sent. */
export async function openMailSender(accountId: string, permit: SendPermit): Promise<MessageSender> {
  const target = (await resolveSmtpTargets(accountId)).find((t) => t.accountId === accountId);
  if (!target) {
    throw new Error(
      fmt(_('no mail account {account} with SMTP — `curlew accounts list` shows them'), {
        account: accountId,
      }),
    );
  }
  return new MailSender(target, permit);
}
