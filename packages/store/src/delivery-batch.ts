import type {
  ChatAttachment,
  ChatMessage,
  ChatPeer,
  DeliveryChat,
  DeliveryEvent,
  Mention,
  ParticipantAddress,
} from '@curlew/protocol';
import { chatConversationId } from './chat-sync.ts';
import type { SqlValue } from './db.ts';
import { thumbnailColumns } from './thumbnails.ts';
import { stableId } from './threads.ts';

export interface KnownChat {
  kind: DeliveryChat['kind'];
  title: string | null;
  lastSeq: number | null;
}

export interface KnownPeer {
  displayName: string | null;
  addresses: ParticipantAddress[];
  bot: boolean;
}

/** The account's chats and peers as stored — loaded once per account, kept current in memory. */
export interface AccountState {
  chats: Map<string, KnownChat>;
  peers: Map<string, KnownPeer>;
}

/** The row id of a delivered message — the same derivation `syncChats` uses. */
export function deliveredMessageId(
  backend: string,
  accountId: string,
  chatRemoteId: string,
  remoteId: string,
): string {
  return stableId('m-', chatConversationId(backend, accountId, chatRemoteId), remoteId);
}

export interface PendingMessage {
  chatRemoteId: string;
  chatKind: DeliveryChat['kind'];
  message: ChatMessage;
  seen: boolean;
  peerRead: boolean;
}

/** One batch folded into the statements it needs, in event order. */
export class DeliveryBatch {
  readonly messages = new Map<string, PendingMessage>();
  readonly deletedMessages = new Set<string>();
  readonly deletedChats = new Set<string>();
  readonly clearedChats = new Set<string>();
  readonly edits = new Map<
    string,
    { text: string | null; mentions: Mention[] | undefined; editedAt: string | null; conversationId: string }
  >();
  readonly peerRead = new Set<string>();
  /** The last reaction of each person to each message, keyed `<row id>\0<reactor>`; a null emoji takes it back. */
  readonly reactions = new Map<
    string,
    { messageId: string; chatRemoteId: string; reactor: string; emoji: string | null }
  >();
  /**
   * Messages read that no chat was named for — a Signal receipt carries sent timestamps only
   * (`refs/signal-desktop/protos/SignalService.proto:451`), so the remote ids are what locate
   * them. Kept apart from `peerRead` because their row ids are not known until the write.
   */
  readonly peerReadByRemoteId = new Set<string>();
  readonly chatRead = new Map<string, number>();
  /**
   * The messages in this batch that carry a sender-given id, by that id → the row id they will be
   * written under. They replace curlew's own local echoes; the row id leads back to the pending
   * message because the echo may hold text the delivered copy does not.
   */
  readonly clientIds = new Map<string, string>();
  /** Attachment rows for chat messages, written once and never rewritten (ADR 0010). */
  readonly messageAttachments: SqlValue[][] = [];
  readonly touchedChats = new Set<string>();
  /** Chats a merge folded into another in this batch: gone as conversations, for the journal. */
  readonly mergedAway = new Set<string>();
  readonly touchedPeers = new Set<string>();
  readonly members = new Map<string, SqlValue[]>();
  /** Counted as events are folded; a message deleted in the same batch still counts once as removed. */
  added = 0;
  edited = 0;
  removed = 0;

  readonly backend: string;
  readonly accountId: string;
  readonly state: AccountState;

  constructor(backend: string, accountId: string, state: AccountState) {
    this.backend = backend;
    this.accountId = accountId;
    this.state = state;
  }

  private conversationId(chatRemoteId: string): string {
    return chatConversationId(this.backend, this.accountId, chatRemoteId);
  }

  private rowId(chatRemoteId: string, remoteId: string): string {
    return deliveredMessageId(this.backend, this.accountId, chatRemoteId, remoteId);
  }

  messageAttachment(messageId: string, idx: number, attachment: ChatAttachment): void {
    this.messageAttachments.push([
      messageId,
      idx,
      attachment.filename,
      attachment.mimeType,
      attachment.size,
      attachment.kind,
      attachment.width,
      attachment.height,
      attachment.durationMs,
      attachment.handle,
      ...thumbnailColumns(messageId, idx, attachment),
    ]);
  }

  /** Merge a peer into what is known: a name or an address is never lost to a report that lacks it. */
  private peer(peer: ChatPeer): void {
    const known = this.state.peers.get(peer.remoteId);
    const addresses = [...(known?.addresses ?? [])];
    for (const a of peer.addresses) {
      if (!addresses.some((b) => b.kind === a.kind && b.value === a.value)) addresses.push(a);
    }
    const merged: KnownPeer = {
      displayName: peer.displayName ?? known?.displayName ?? null,
      addresses,
      bot: peer.bot || (known?.bot ?? false),
    };
    this.state.peers.set(peer.remoteId, merged);
    this.touchedPeers.add(peer.remoteId);
  }

  private member(chatRemoteId: string, peer: ChatPeer): void {
    this.peer(peer);
    const conversationId = this.conversationId(chatRemoteId);
    this.members.set(`${conversationId}\u0000${peer.remoteId}`, [
      conversationId,
      this.backend,
      this.accountId,
      peer.remoteId,
    ]);
  }

  private chat(chatRemoteId: string, kind: DeliveryChat['kind'], title?: string | null): KnownChat {
    const known = this.state.chats.get(chatRemoteId);
    const next: KnownChat = {
      kind,
      // A report without a title keeps the one already known.
      title: title === undefined || title === null ? (known?.title ?? null) : title,
      lastSeq: known?.lastSeq ?? null,
    };
    this.state.chats.set(chatRemoteId, next);
    this.touchedChats.add(chatRemoteId);
    return next;
  }

  apply(event: DeliveryEvent): void {
    switch (event.type) {
      case 'chat': {
        this.chat(event.chat.remoteId, event.chat.kind, event.chat.title);
        for (const m of event.chat.members ?? []) this.member(event.chat.remoteId, m);
        return;
      }
      case 'peer':
        this.peer(event.peer);
        return;
      case 'message': {
        const { chatRemoteId, message } = event;
        const known = this.chat(chatRemoteId, this.state.chats.get(chatRemoteId)?.kind ?? event.chatKind);
        if (message.seq > (known.lastSeq ?? Number.NEGATIVE_INFINITY)) known.lastSeq = message.seq;
        if (!message.fromSelf && message.sender) this.member(chatRemoteId, message.sender);
        const id = this.rowId(chatRemoteId, message.remoteId);
        this.deletedMessages.delete(id);
        if (message.clientId) this.clientIds.set(message.clientId, id);
        if (!this.messages.has(id)) this.added++;
        this.messages.set(id, {
          chatRemoteId,
          chatKind: known.kind,
          message,
          seen: message.fromSelf || event.seen,
          peerRead: false,
        });
        if (message.attachments) {
          for (let i = 0; i < message.attachments.length; i++) {
            this.messageAttachment(id, i, message.attachments[i]);
          }
        }
        return;
      }
      case 'edit': {
        const id = this.rowId(event.chatRemoteId, event.remoteId);
        const pending = this.messages.get(id);
        if (pending) {
          pending.message = { ...pending.message, text: event.text, mentions: event.mentions, editedAt: event.editedAt };
        } else if (!this.deletedMessages.has(id)) {
          this.edits.set(id, {
            text: event.text,
            mentions: event.mentions,
            editedAt: event.editedAt,
            conversationId: this.conversationId(event.chatRemoteId),
          });
          this.touchedChats.add(event.chatRemoteId);
        }
        this.edited++;
        return;
      }
      case 'reaction': {
        const messageId = this.rowId(event.chatRemoteId, event.remoteId);
        if (this.deletedMessages.has(messageId)) return;
        const reactor = event.reactor ?? '';
        this.reactions.set(`${messageId}\0${reactor}`, {
          messageId,
          chatRemoteId: event.chatRemoteId,
          reactor,
          emoji: event.emoji,
        });
        return;
      }
      case 'delete': {
        const id = this.rowId(event.chatRemoteId, event.remoteId);
        if (this.messages.delete(id)) this.added--;
        this.edits.delete(id);
        for (const [key, reaction] of this.reactions) if (reaction.messageId === id) this.reactions.delete(key);
        this.deletedMessages.add(id);
        this.removed++;
        if (this.state.chats.has(event.chatRemoteId)) this.touchedChats.add(event.chatRemoteId);
        return;
      }
      case 'peer-read': {
        const chatRemoteId = event.chatRemoteId;
        for (const remoteId of event.remoteIds) {
          if (chatRemoteId !== null) {
            const id = this.rowId(chatRemoteId, remoteId);
            const pending = this.messages.get(id);
            if (pending) pending.peerRead = true;
            else this.peerRead.add(id);
            continue;
          }
          // No chat named: the remote id is the whole identity, so every pending message that
          // carries it is the message the other side read, in whatever chat it ended up.
          let pendingAny = false;
          for (const pending of this.messages.values()) {
            if (pending.message.remoteId !== remoteId) continue;
            pending.peerRead = true;
            pendingAny = true;
          }
          if (!pendingAny) this.peerReadByRemoteId.add(remoteId);
        }
        if (chatRemoteId !== null && this.state.chats.has(chatRemoteId)) this.touchedChats.add(chatRemoteId);
        return;
      }
      case 'chat-read': {
        this.chatRead.set(event.chatRemoteId, Math.max(0, Math.floor(event.unreadCount)));
        if (this.state.chats.has(event.chatRemoteId)) this.touchedChats.add(event.chatRemoteId);
        return;
      }
      case 'chat-mute':
        // Applied by `writeEvents` after the batch is written: the flag has its own transaction.
        return;
      case 'chat-merged':
        // Handled by `writeEvents`, which splits the batch around it.
        return;
      case 'chat-cleared':
      case 'chat-deleted': {
        for (const [id, pending] of this.messages) {
          if (pending.chatRemoteId === event.chatRemoteId) {
            this.messages.delete(id);
            this.added--;
          }
        }
        for (const [id, edit] of this.edits) {
          if (edit.conversationId === this.conversationId(event.chatRemoteId)) this.edits.delete(id);
        }
        if (event.type === 'chat-cleared') {
          this.clearedChats.add(event.chatRemoteId);
          if (this.state.chats.has(event.chatRemoteId)) this.touchedChats.add(event.chatRemoteId);
        } else {
          this.deletedChats.add(event.chatRemoteId);
          this.state.chats.delete(event.chatRemoteId);
          this.touchedChats.delete(event.chatRemoteId);
          for (const key of this.members.keys()) {
            if (key.startsWith(`${this.conversationId(event.chatRemoteId)}\u0000`)) this.members.delete(key);
          }
        }
        this.removed++;
        return;
      }
    }
  }
}
