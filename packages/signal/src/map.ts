/**
 * Decrypted Signal content → the network-neutral `DeliveryEvent`s of `@postbote/protocol`.
 *
 * Pure: it reads the decoded messages (`schema.ts`) and a group-id function, so every rule here is
 * tested against synthetic content on both runtimes. The rules follow Signal-Desktop's
 * `ts/textsecure/MessageReceiver.preload.ts` and `processDataMessage.preload.ts`.
 *
 * Identity. Signal names a message by its author and the author's sent timestamp — edits,
 * deletes, quotes and receipts all point at that pair — so a message's remote id is
 * `<author ACI>:<sent timestamp>`, and an edit or delete from X can only ever reach X's messages.
 * A direct chat is the other person's ACI; a group is `group:<base64 group id>`, the id derived
 * from the master key every group message carries. A read receipt is the one thing that carries
 * no chat at all, so it is mapped without one and resolved by the message.
 *
 * What is kept: what people wrote (text, a caption, a file name, a poll's question, a shared
 * contact's name), that a file came with it, the message it quotes, edits, deletes for everyone,
 * the user's own messages sent from the phone (sent transcripts), deletions the user made on the
 * phone, and read receipts for the user's messages. What is dropped: reactions, stories and
 * replies to them, typing, calls, payments, gift badges, group-call notices, poll votes, pins,
 * timer and profile-key updates, session resets — and every sync message that did not come from
 * the user's own account (only the user's devices may speak for the user).
 *
 * Read state on the phone (`SyncMessage.read`) is not mirrored: a read receipt names one message,
 * the index counts unread per chat, and a wrong guess would mark unseen messages read.
 */

import type { ChatMessage, ChatPeer, DeliveryEvent } from '@postbote/protocol';
import {
  type AttachmentPointer,
  type Content,
  type ConversationRef,
  type DataMessage,
  DataMessageFlags,
  isAci,
  ReceiptType,
  type SyncMessage,
} from './schema.ts';
import { toBase64 } from './protocol-store.ts';

export const GROUP_PREFIX = 'group:';

export function messageRemoteId(authorAci: string, sentTimestamp: number): string {
  return `${authorAci}:${sentTimestamp}`;
}

export function peerOf(
  aci: string,
  displayName: string | null = null,
  phone: string | null = null,
): ChatPeer {
  const addresses: ChatPeer['addresses'] = [{ kind: 'signal', value: aci }];
  if (phone) addresses.push({ kind: 'phone', value: phone });
  return { remoteId: aci, displayName, addresses, bot: false };
}

export interface MappedContent {
  events: DeliveryEvent[];
  /** A contact-sync blob to download and read; only ever from the user's own account. */
  contactsBlob: AttachmentPointer | null;
}

export interface MapContext {
  senderAci: string;
  /** The envelope's client timestamp: the sent timestamp of what the sender sent. */
  timestamp: number;
  /** The group of a sealed sender-key message, when the envelope named one. */
  groupId: Uint8Array | null;
}

export class SignalMapper {
  private readonly ownAci: string;
  private readonly ownPni: string | null;
  private readonly groupIdOf: (masterKey: Uint8Array) => Uint8Array;

  /** `groupIdOf` derives a group's public id from its master key (libsignal zkgroup). */
  /**
   * @param ownPni This account's phone number identity, when it was provisioned with one. Null on
   *   a session linked before it was kept, which is exactly why the fallback has to be honest:
   *   without it our own number cannot be told from a contact's.
   */
  constructor(
    ownAci: string,
    groupIdOf: (masterKey: Uint8Array) => Uint8Array,
    ownPni: string | null = null,
  ) {
    this.ownAci = ownAci;
    this.ownPni = ownPni;
    this.groupIdOf = groupIdOf;
  }

  /**
   * Whether `id` names this account rather than somebody else.
   *
   * `isAci` cannot answer it: the legacy string field carries a bare uuid with no `PNI:` tag, so a
   * self-note addressed to our own number arrives looking exactly like a contact's address. Left
   * unchecked, our own number is written into the peer directory as a person to write to, and the
   * self-chat splits across two conversations.
   */
  private isOwnServiceId(id: string | null): id is string {
    if (!id) return false;
    if (id === this.ownAci) return true;
    if (!this.ownPni) return false;
    // The stored form is `PNI:<uuid>`; the wire may carry the bare uuid in either case.
    const bare = this.ownPni.startsWith('PNI:') ? this.ownPni.slice(4) : this.ownPni;
    return id.toLowerCase() === bare.toLowerCase() || id.toLowerCase() === `pni:${bare.toLowerCase()}`;
  }

  groupChatId(groupId: Uint8Array): string {
    return `${GROUP_PREFIX}${toBase64(groupId)}`;
  }

  private chatOfData(
    data: DataMessage | null,
    fallback: Uint8Array | null,
    direct: string,
  ): {
    id: string;
    kind: 'direct' | 'group';
  } {
    if (data?.groupMasterKey?.length)
      return { id: this.groupChatId(this.groupIdOf(data.groupMasterKey)), kind: 'group' };
    if (fallback?.length) return { id: this.groupChatId(fallback), kind: 'group' };
    return { id: direct, kind: 'direct' };
  }

  private chatOfRef(ref: ConversationRef | null): string | null {
    if (!ref) return null;
    if (ref.groupId?.length) return this.groupChatId(ref.groupId);
    if (isAci(ref.serviceId)) return ref.serviceId;
    return null;
  }

  map(content: Content, context: MapContext): MappedContent {
    const out: MappedContent = { events: [], contactsBlob: null };
    const fromSelf = context.senderAci === this.ownAci;
    if (content.syncMessage) {
      // Only the user's own devices speak for the user.
      if (fromSelf) this.sync(content.syncMessage, out);
      return out;
    }
    if (content.dataMessage) {
      const chat = this.chatOfData(content.dataMessage, context.groupId, context.senderAci);
      const ts = content.dataMessage.timestamp ?? context.timestamp;
      this.data(content.dataMessage, context.senderAci, ts, chat, false, out.events);
      return out;
    }
    if (content.editMessage?.dataMessage && content.editMessage.targetSentTimestamp !== null) {
      const chat = this.chatOfData(content.editMessage.dataMessage, context.groupId, context.senderAci);
      const edited = this.messageText(content.editMessage.dataMessage);
      out.events.push({
        type: 'edit',
        chatRemoteId: chat.id,
        remoteId: messageRemoteId(context.senderAci, content.editMessage.targetSentTimestamp),
        text: edited.text,
        editedAt: new Date(context.timestamp).toISOString(),
      });
      return out;
    }
    if (
      content.receipt &&
      (content.receipt.type === ReceiptType.READ || content.receipt.type === ReceiptType.VIEWED)
    ) {
      if (content.receipt.timestamps.length > 0) {
        // No chat: a `ReceiptMessage` carries a type and sent timestamps and names no
        // conversation (`refs/signal-desktop/protos/SignalService.proto:451`), so the message —
        // identified the way Signal itself identifies it, by author and sent timestamp — is the
        // only thing a receipt can be resolved against. That is what Signal-Desktop does too: its
        // read events carry the source service id and the timestamp, and nothing else.
        out.events.push({
          type: 'peer-read',
          chatRemoteId: null,
          remoteIds: content.receipt.timestamps.map((t) => messageRemoteId(this.ownAci, t)),
        });
      }
    }
    return out;
  }

  private sync(sync: SyncMessage, out: MappedContent): void {
    const sent = sync.sent;
    if (sent && !sent.story) {
      const data = sent.message ?? sent.editMessage?.dataMessage ?? null;
      const destination = sent.destinationServiceId;
      // Ours, whichever of our identities it names — not a peer to announce. A transcript with
      // no destination at all was ours too: only the user's own devices send one.
      const isOurs = destination === null || this.isOwnServiceId(destination);
      const direct = isOurs ? this.ownAci : destination;
      const chat = this.chatOfData(data, null, direct);
      if (chat.kind === 'direct' && !isOurs) {
        out.events.push({
          type: 'chat',
          chat: { remoteId: direct, kind: 'direct', title: null, members: [peerOf(direct)] },
        });
      }
      if (sent.message && sent.timestamp !== null) {
        this.data(
          sent.message,
          this.ownAci,
          sent.message.timestamp ?? sent.timestamp,
          chat,
          true,
          out.events,
        );
      }
      if (sent.editMessage?.dataMessage && sent.editMessage.targetSentTimestamp !== null) {
        out.events.push({
          type: 'edit',
          chatRemoteId: chat.id,
          remoteId: messageRemoteId(this.ownAci, sent.editMessage.targetSentTimestamp),
          text: this.messageText(sent.editMessage.dataMessage).text,
          editedAt: sent.timestamp !== null ? new Date(sent.timestamp).toISOString() : null,
        });
      }
    }
    if (sync.contacts?.blob) out.contactsBlob = sync.contacts.blob;
    const del = sync.deleteForMe;
    if (del) {
      for (const group of del.messageDeletes) {
        const chat = this.chatOfRef(group.conversation);
        if (!chat) continue;
        for (const m of group.messages) {
          if (!isAci(m.authorServiceId) || m.sentTimestamp === null) continue;
          out.events.push({
            type: 'delete',
            chatRemoteId: chat,
            remoteId: messageRemoteId(m.authorServiceId, m.sentTimestamp),
          });
        }
      }
      for (const c of del.conversationDeletes) {
        const chat = this.chatOfRef(c.conversation);
        if (chat)
          out.events.push({ type: c.isFullDelete ? 'chat-deleted' : 'chat-cleared', chatRemoteId: chat });
      }
      for (const c of del.localOnlyConversationDeletes) {
        const chat = this.chatOfRef(c.conversation);
        if (chat) out.events.push({ type: 'chat-deleted', chatRemoteId: chat });
      }
    }
  }

  /** The text a list shows for a message, and whether a file came with it. Null text: nothing written. */
  messageText(data: DataMessage): { text: string | null; hasAttachments: boolean } {
    const first = data.attachments[0];
    const text =
      data.body ??
      first?.caption ??
      first?.fileName ??
      data.pollQuestion ??
      (data.contacts.length > 0 ? data.contacts.filter(Boolean).join(', ') || null : null);
    return { text, hasAttachments: data.attachments.length > 0 || data.sticker || data.contacts.length > 0 };
  }

  private data(
    data: DataMessage,
    authorAci: string,
    sentAt: number,
    chat: { id: string; kind: 'direct' | 'group' },
    transcript: boolean,
    events: DeliveryEvent[],
  ): void {
    const fromSelf = authorAci === this.ownAci;
    if (data.deleteTarget !== null) {
      events.push({
        type: 'delete',
        chatRemoteId: chat.id,
        remoteId: messageRemoteId(authorAci, data.deleteTarget),
      });
      return;
    }
    if (data.adminDelete) {
      // An admin removing someone else's message needs the group's roles to check; postbote has
      // none, so only a delete of the sender's own message is taken.
      const { authorAci: target, timestamp } = data.adminDelete;
      if (target === authorAci && timestamp !== null) {
        events.push({
          type: 'delete',
          chatRemoteId: chat.id,
          remoteId: messageRemoteId(authorAci, timestamp),
        });
      }
      return;
    }
    if (data.reaction || data.special) return;
    const housekeeping =
      data.flags &
      (DataMessageFlags.END_SESSION |
        DataMessageFlags.EXPIRATION_TIMER_UPDATE |
        DataMessageFlags.PROFILE_KEY_UPDATE);
    const { text, hasAttachments } = this.messageText(data);
    if (housekeeping && text === null && !hasAttachments) return;
    if (text === null && !hasAttachments) return;
    const message: ChatMessage = {
      remoteId: messageRemoteId(authorAci, sentAt),
      seq: sentAt,
      sentAt: new Date(sentAt).toISOString(),
      editedAt: null,
      sender: fromSelf ? null : peerOf(authorAci),
      fromSelf,
      text,
      hasAttachments,
      replyToRemoteId:
        data.quote?.authorAci && data.quote.id !== null
          ? messageRemoteId(data.quote.authorAci, data.quote.id)
          : null,
      threadRemoteId: null,
    };
    events.push({ type: 'message', chatRemoteId: chat.id, chatKind: chat.kind, message, seen: transcript });
  }
}
