/**
 * The `MessageSender` view of a granted XMPP session (ADR 0004 §5, amended 2026-10-30).
 *
 * `GrantedXmppSession` stays the XMPP-shaped handle (origin-id, OMEMO, XEP-0066); this adapter
 * is what the app's backend-agnostic send action sees, so no frontend names a stanza field.
 * Nothing here decides anything: the permit check and the encryption policy are the session's.
 */

import type { MessageSender, SenderFeatures, SendingMessage, SentMessage } from '@curlew/protocol';
import type { GrantedXmppSession, SentChat } from './granted.ts';

function sent(sentChat: SentChat): SentMessage {
  return {
    target: sentChat.chatJid,
    id: sentChat.originId,
    sentAt: sentChat.sentAt,
    chatRemoteId: sentChat.chatJid,
    encrypted: sentChat.encrypted,
  };
}

export class XmppSender implements MessageSender {
  /** Long texts are rendered as XEP-0393 and split (see `core/markdown.ts`). */
  readonly features: SenderFeatures = { markdown: true };
  private readonly session: GrantedXmppSession;

  constructor(session: GrantedXmppSession) {
    this.session = session;
  }

  async send(message: SendingMessage): Promise<SentMessage> {
    return sent(await this.session.send(message.to, message.text));
  }

  async sendImage(to: string, url: string): Promise<SentMessage> {
    return sent(await this.session.sendImage(to, url));
  }

  close(): Promise<void> {
    return this.session.close();
  }
}
