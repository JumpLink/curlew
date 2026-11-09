/**
 * Telegram's objects → the network-neutral chat driver types of `@curlew/protocol`.
 *
 * Pure: it reads the structural shapes in `api.ts`, so every rule here is tested against
 * synthetic objects on both runtimes.
 */

import type {
  AttachmentKind,
  ChatAttachment,
  ChatInfo,
  ChatMessage,
  ChatPeer,
  ParticipantAddress,
} from '@curlew/protocol';
import { normalizeAddress } from '@curlew/protocol';
import type { TgDialog, TgMedia, TgMessage, TgPeer } from './api.ts';

/** Media that is a file a person sent. A link preview (`webpage`), a poll or a dice roll is not. */
const FILE_MEDIA = new Set(['photo', 'video', 'audio', 'voice', 'document', 'sticker', 'paid']);

/** What the window shows an attachment as: by MIME type, except where Telegram has its own word. */
function attachmentKind(media: TgMedia, mimeType: string | null): AttachmentKind {
  if (media.type === 'voice') return 'voice';
  if (media.type === 'photo') return 'image';
  const major = mimeType?.split('/')[0];
  if (major === 'image' || major === 'video' || major === 'audio') return major;
  return 'file';
}

/** The backend-private handle: where to find the message again. File references expire; ids do not. */
export function attachmentHandle(chatId: number, messageId: number): string {
  return JSON.stringify({ chatId, messageId });
}

/** The ids behind a stored handle, or null when it is not one this backend wrote. */
export function parseAttachmentHandle(handle: string): { chatId: number; messageId: number } | null {
  try {
    const value: unknown = JSON.parse(handle);
    if (typeof value !== 'object' || value === null) return null;
    const { chatId, messageId } = value as Record<string, unknown>;
    if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) return null;
    return { chatId: chatId as number, messageId: messageId as number };
  } catch {
    return null;
  }
}

/** The one file a message carries, or none: a link preview, a poll or paid media has nothing to fetch. */
function toChatAttachments(message: TgMessage): ChatAttachment[] | undefined {
  const media = message.media;
  if (media === null || media.type === 'paid' || !FILE_MEDIA.has(media.type)) return undefined;
  // A photo is always re-encoded to JPEG by Telegram and carries no MIME type of its own.
  const mimeType = media.type === 'photo' ? 'image/jpeg' : (media.mimeType ?? null);
  return [
    {
      filename: media.fileName ?? null,
      mimeType,
      size: media.fileSize ?? null,
      kind: attachmentKind(media, mimeType),
      width: media.width ?? null,
      height: media.height ?? null,
      durationMs: typeof media.duration === 'number' ? Math.round(media.duration * 1000) : null,
      handle: attachmentHandle(message.chat.id, message.id),
    },
  ];
}

function address(kind: ParticipantAddress['kind'], raw: string | null): ParticipantAddress | null {
  if (!raw) return null;
  const value = normalizeAddress(kind, raw);
  return value ? { kind, value } : null;
}

/**
 * A peer's addresses, the stable one first: the numeric user id never changes, a username can.
 * The phone number is only there when the user shares it with you (or is your contact) —
 * Telegram reports it as bare digits, always international, so it gains its `+` here.
 */
export function peerAddresses(peer: TgPeer): ParticipantAddress[] {
  const found: Array<ParticipantAddress | null> =
    peer.type === 'user'
      ? [
          address('telegram', String(peer.id)),
          address('telegram', peer.username),
          address('phone', peer.phoneNumber ? `+${peer.phoneNumber.replace(/^\+/, '')}` : null),
        ]
      : // A group or channel has no user id to address; a public one has a handle.
        [address('telegram', peer.username)];
  return found.filter((a): a is ParticipantAddress => a !== null);
}

export function toChatPeer(peer: TgPeer): ChatPeer {
  return {
    remoteId: String(peer.id),
    displayName: peer.displayName || null,
    addresses: peerAddresses(peer),
    bot: peer.type === 'user' && peer.isBot,
  };
}

export function chatKind(peer: TgPeer): ChatInfo['kind'] {
  if (peer.type === 'user') return 'direct';
  // A channel is one-way; every other chat type (group, supergroup, gigagroup, forum) is a group.
  return peer.chatType === 'channel' ? 'broadcast' : 'group';
}

export function toChatInfo(dialog: TgDialog): ChatInfo {
  const peer = dialog.peer;
  const direct = peer.type === 'user';
  return {
    remoteId: String(peer.id),
    kind: chatKind(peer),
    // A direct chat has no title of its own; the other person's name is what a list shows.
    title: peer.displayName || null,
    // The "Saved Messages" chat is with yourself: nobody else is in it.
    members: direct && !peer.isSelf ? [toChatPeer(peer)] : [],
    lastSeq: dialog.lastMessage?.id ?? null,
    readInboxSeq: dialog.lastReadIngoing || null,
    readOutboxSeq: dialog.lastReadOutgoing || null,
  };
}

/**
 * The network message id, unique within the account: Telegram's message ids are unique only
 * within a chat for channels and supergroups, so the chat is part of it.
 */
export function remoteMessageId(chatId: number | string, messageId: number): string {
  return `${chatId}/${messageId}`;
}

/** One message, or null for a service notice (joins, pins, title changes). */
export function toChatMessage(message: TgMessage): ChatMessage | null {
  if (message.isService) return null;
  const chatId = message.chat.id;
  const sender = message.sender.type === 'anonymous' ? null : message.sender;
  const reply = message.replyToMessage;
  // Telegram does not flag a message in Saved Messages as outgoing, though you wrote it.
  const fromSelf = message.isOutgoing || (sender?.type === 'user' && sender.isSelf);
  return {
    remoteId: remoteMessageId(chatId, message.id),
    seq: message.id,
    sentAt: message.date.toISOString(),
    editedAt: message.editDate ? message.editDate.toISOString() : null,
    sender: fromSelf || !sender ? null : toChatPeer(sender),
    fromSelf,
    // What `TelegramSender` returns as the sent id, so the next sync replaces curlew's local echo.
    // Chat-qualified: echoes are matched per account, and a channel's message ids repeat others'.
    clientId: fromSelf ? remoteMessageId(chatId, message.id) : null,
    text: message.text || null,
    hasAttachments: message.media !== null && FILE_MEDIA.has(message.media.type),
    attachments: toChatAttachments(message),
    replyToRemoteId: reply?.id ? remoteMessageId(chatId, reply.id) : null,
    threadRemoteId:
      message.isTopicMessage && reply?.threadId ? remoteMessageId(chatId, reply.threadId) : null,
    groupId: message.groupedIdUnique ?? null,
  };
}
