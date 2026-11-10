/**
 * The `MessageSender` view of a granted XMPP session (ADR 0004 §5, amended 2026-10-30).
 *
 * `GrantedXmppSession` stays the XMPP-shaped handle (origin-id, OMEMO, XEP-0066); this adapter
 * is what the app's backend-agnostic send action sees, so no frontend names a stanza field.
 * Nothing here decides anything: the permit check and the encryption policy are the session's.
 */

import { readFileSync } from 'node:fs';

import type { MessageSender, ReplyTarget, SenderFeatures, SendingMessage, SentMessage } from '@curlew/protocol';
import { inspectSendFiles } from '@curlew/store';
import type { GrantedXmppSession, SentChat } from './granted.ts';
import { MESSAGES } from './messages.ts';

function sent(sentChat: SentChat): SentMessage {
  return {
    target: sentChat.chatJid,
    id: sentChat.originId,
    sentAt: sentChat.sentAt,
    chatRemoteId: sentChat.chatJid,
    encrypted: sentChat.encrypted,
  };
}

/**
 * What one file may weigh. The upload service's own limit (often 10–100 MB) is checked after
 * this, by the slot request; this one keeps a file — and its encrypted copy — from filling memory.
 */
export const XMPP_MAX_FILE_BYTES = 50_000_000;

/** How many files one message may carry; each becomes its own message. */
export const XMPP_MAX_FILES = 10;

export class XmppSender implements MessageSender {
  /** Long texts are rendered as XEP-0393 and split (see `core/markdown.ts`). */
  readonly features: SenderFeatures = {
    markdown: true,
    attachments: true,
    replies: true,
    reactions: false,
  };
  private readonly session: GrantedXmppSession;

  constructor(session: GrantedXmppSession) {
    this.session = session;
  }

  /**
   * Files first, one message each, then the text: a file's stanza is a bare link and cannot carry
   * a caption, so the text follows as a message of its own. The result is the first message sent
   * (the file, else the text); the others reach the index with the next sync.
   */
  async send(message: SendingMessage): Promise<SentMessage> {
    const files = inspectSendFiles(message.attachments ?? [], {
      perFile: XMPP_MAX_FILE_BYTES,
      count: XMPP_MAX_FILES,
    });
    const answers = message.replyTo && this.answers(message.replyTo);
    if (answers && files.length > 0 && message.text.trim().length === 0) {
      throw new Error(MESSAGES.replyNeedsText);
    }
    if (files.length === 0) return sent(await this.session.send(message.to, message.text, undefined, answers));
    let first: SentMessage | undefined;
    for (const file of files) {
      const out = sent(
        await this.session.sendFile(message.to, {
          bytes: readFileSync(file.realPath),
          filename: file.filename,
          contentType: file.contentType,
        }),
      );
      first ??= { ...out, attachments: files.map((f) => ({ filename: f.filename, size: f.size })) };
    }
    if (message.text.trim().length > 0) await this.session.send(message.to, message.text, undefined, answers);
    return first!;
  }

  /** The id a reply names is the one the sender gave the message; the archive's id is no use to the peer. */
  private answers(target: ReplyTarget): { id: string; fromSelf: boolean } {
    if (!target.clientId) throw new Error(MESSAGES.replyNoId);
    return { id: target.clientId, fromSelf: target.fromSelf === true };
  }

  async sendImage(to: string, url: string): Promise<SentMessage> {
    return sent(await this.session.sendImage(to, url));
  }

  close(): Promise<void> {
    return this.session.close();
  }
}
