/**
 * The `MessageSender` view of a granted XMPP session (ADR 0004 §5, amended 2026-10-30).
 *
 * `GrantedXmppSession` stays the XMPP-shaped handle (origin-id, OMEMO, XEP-0066); this adapter
 * is what the app's backend-agnostic send action sees, so no frontend names a stanza field.
 * Nothing here decides anything: the permit check and the encryption policy are the session's.
 */

import { readFileSync } from 'node:fs';

import type {
  ChatAttachment,
  MessageSender,
  ReplyTarget,
  SenderFeatures,
  SendingMessage,
  SendingDeletion,
  SendingEdit,
  SendingReaction,
  SendingReadSync,
  SentMessage,
} from '@curlew/protocol';
import { probeMediaFile } from '@curlew/protocol';
import { inspectSendFiles } from '@curlew/store';
import { attachmentsOfLinks } from './attachment-link.ts';
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

/** The row the index holds for a file just sent: what a received copy of the same link maps to, plus what we know. */
function echoOf(
  link: string | undefined,
  file: { realPath: string; contentType: string; size: number },
): ChatAttachment | null {
  if (link === undefined) return null;
  const [row] = attachmentsOfLinks([link]);
  if (row === undefined) return null;
  const probe = probeMediaFile(file.realPath, file.contentType);
  const major = file.contentType.split('/')[0];
  return {
    ...row,
    mimeType: file.contentType,
    size: file.size,
    kind: major === 'image' || major === 'video' || major === 'audio' ? major : 'file',
    width: probe.width,
    height: probe.height,
    durationMs: probe.durationMs,
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
  /**
   * Long texts are rendered as XEP-0393 and split (see `core/markdown.ts`). Reactions, edits and
   * deletes are what the network can do; one thread offers them only when its peer advertises the
   * XEP (`narrowXmppThread`).
   */
  readonly features: SenderFeatures = {
    markdown: true,
    attachments: true,
    replies: true,
    reactions: true,
    edits: true,
    deletes: true,
    readSync: true,
    clientIds: true,
  };
  private readonly session: GrantedXmppSession;

  constructor(session: GrantedXmppSession) {
    this.session = session;
  }

  /**
   * Files first, one message each, then the text: a file's stanza is a bare link and cannot carry
   * a caption, so the text follows as a message of its own. The result is the first message sent
   * (the file, else the text); the others reach the index with the next sync.
   *
   * `message.clientId` becomes the `origin-id` of a text-only send (ADR 0021 §2), which is the one
   * case where the id this method RETURNS is the id the caller asked for. A send with files is
   * several stanzas with ids of their own and the first of them is a file, so the caller's id
   * would name a message other than the result: it is left unused there and the caller matches
   * its echo by content instead.
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
    if (files.length === 0)
      return sent(await this.session.send(message.to, message.text, undefined, answers, message.clientId));
    let first: SentMessage | undefined;
    for (const file of files) {
      const chat = await this.session.sendFile(message.to, {
        bytes: readFileSync(file.realPath),
        filename: file.filename,
        contentType: file.contentType,
      });
      const echo = echoOf(chat.link, file);
      first ??= {
        ...sent(chat),
        attachments: files.map((f) => ({ filename: f.filename, size: f.size })),
        ...(echo === null ? {} : { echoAttachments: [echo] }),
      };
    }
    if (message.text.trim().length > 0) await this.session.send(message.to, message.text, undefined, answers);
    return first!;
  }

  /** The id a reply names is the one the sender gave the message; the archive's id is no use to the peer. */
  private answers(target: ReplyTarget): { id: string; fromSelf: boolean } {
    if (!target.clientId) throw new Error(MESSAGES.replyNoId);
    return { id: target.clientId, fromSelf: target.fromSelf === true };
  }

  /** Names the message by the id its sender gave it, like a reply; the archive's id is no use to the peer. */
  async react(reaction: SendingReaction): Promise<void> {
    if (!reaction.target.clientId) throw new Error(MESSAGES.reactNoId);
    await this.session.react(reaction.to, reaction.target.clientId, reaction.emoji);
  }

  /** Names the message by the id its sender gave it, like a reaction. */
  async edit(edit: SendingEdit): Promise<void> {
    await this.session.correct(edit.to, this.ownId(edit.target), edit.text);
  }

  async delete(deletion: SendingDeletion): Promise<void> {
    await this.session.retract(deletion.to, this.ownId(deletion.target));
  }

  /** The archive id of the newest message read: what XEP-0490 names, not the sender's own id. */
  async readSync(sync: SendingReadSync): Promise<void> {
    await this.session.markDisplayed(sync.to, sync.target.remoteId);
  }

  private ownId(target: ReplyTarget): string {
    if (target.fromSelf !== true) throw new Error(MESSAGES.changeNotOwn);
    if (!target.clientId) throw new Error(MESSAGES.changeNoId);
    return target.clientId;
  }

  async sendImage(to: string, url: string): Promise<SentMessage> {
    return sent(await this.session.sendImage(to, url));
  }

  close(): Promise<void> {
    return this.session.close();
  }
}
