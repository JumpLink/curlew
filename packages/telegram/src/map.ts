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
  Mention,
  ChatPeer,
  ChatReaction,
  ParticipantAddress,
} from '@curlew/protocol';
import { normalizeAddress, normalizeMentions } from '@curlew/protocol';
import type { TgDialog, TgMedia, TgMessage, TgPeer, TgThumbnail } from './api.ts';
import { strippedToJpeg } from './stripped-jpeg.ts';

/** The store drops an inline preview above this (ADR 0017); a stripped JPEG is far below it. */
const MAX_INLINE_THUMBNAIL_BYTES = 16 * 1024;

/** Telegram's fetchable picture sizes, smallest first. `i` (inline), `j` (vector) and `v` (video) are not among them. */
const THUMB_ORDER = ['s', 'a', 'm', 'b', 'x', 'c', 'y', 'd', 'w'];

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

/** The backend-private handle of one preview size of a message's media. */
export function thumbHandle(chatId: number, messageId: number, thumb: string): string {
  return JSON.stringify({ chatId, messageId, thumb });
}

/** The ids and size letter behind a stored thumbnail handle, or null when it is not one. */
export function parseThumbHandle(handle: string): { chatId: number; messageId: number; thumb: string } | null {
  try {
    const value: unknown = JSON.parse(handle);
    if (typeof value !== 'object' || value === null) return null;
    const { chatId, messageId, thumb } = value as Record<string, unknown>;
    if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) return null;
    if (typeof thumb !== 'string' || thumb === '') return null;
    return { chatId: chatId as number, messageId: messageId as number, thumb };
  } catch {
    return null;
  }
}

/** The preview a message ships inline (an expanded stripped JPEG), else the smallest size to fetch. */
function thumbnailFields(
  thumbnails: ReadonlyArray<TgThumbnail> | undefined,
  chatId: number,
  messageId: number,
): Pick<ChatAttachment, 'thumbnail' | 'thumbHandle'> {
  if (!thumbnails || thumbnails.length === 0) return {};
  for (const t of thumbnails) {
    if (t.raw?._ !== 'photoStrippedSize' || !t.raw.bytes) continue;
    const jpeg = strippedToJpeg(t.raw.bytes);
    if (jpeg !== null && jpeg.byteLength <= MAX_INLINE_THUMBNAIL_BYTES) return { thumbnail: jpeg };
  }
  const rank = (type: string) => THUMB_ORDER.indexOf(type);
  const smallest = thumbnails
    .filter((t) => rank(t.type) >= 0)
    .sort((a, b) => rank(a.type) - rank(b.type))[0];
  return smallest ? { thumbHandle: thumbHandle(chatId, messageId, smallest.type) } : {};
}

/** The one file a message carries, or none: a link preview, a poll or paid media has nothing to fetch. */
export function toChatAttachments(message: TgMessage): ChatAttachment[] | undefined {
  const media = message.media;
  if (media === null || media.type === 'paid' || !FILE_MEDIA.has(media.type)) return undefined;
  // A photo is always re-encoded to JPEG by Telegram and carries no MIME type of its own.
  const mimeType = media.type === 'photo' ? 'image/jpeg' : (media.mimeType ?? null);
  return [
    {
      // An animated sticker (Lottie) is no picture the window can decode, so it stays a file tile; it
      // gets a name so the tile has a label, and its preview comes from the thumbnail below.
      filename: media.fileName ?? (mimeType === 'application/x-tgsticker' ? 'sticker.tgs' : null),
      mimeType,
      size: media.fileSize ?? null,
      kind: attachmentKind(media, mimeType),
      width: media.width ?? null,
      height: media.height ?? null,
      durationMs: typeof media.duration === 'number' ? Math.round(media.duration * 1000) : null,
      handle: attachmentHandle(message.chat.id, message.id),
      ...thumbnailFields(media.thumbnails, message.chat.id, message.id),
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

/** Most reaction rows kept for one emoji of one message: a channel post can have thousands. */
const MAX_REACTORS_PER_EMOJI = 100;

/**
 * The reactions of a message. Telegram reports counts, not people, so each person beyond the
 * account itself becomes a placeholder reactor `telegram:<emoji>:<n>`; the store counts rows.
 * The first reaction replaces everything stored for the message, since this is its whole state.
 */
export function toChatReactions(message: TgMessage): ChatReaction[] {
  if (message.isService) return [];
  const remoteId = remoteMessageId(message.chat.id, message.id);
  const out: ChatReaction[] = [];
  for (const { emoji, isPaid, count, order } of message.reactions?.reactions ?? []) {
    if (typeof emoji !== 'string' || emoji === '' || isPaid) continue;
    const own = order !== null;
    if (own) out.push({ remoteId, reactor: null, emoji });
    const others = Math.min(count - (own ? 1 : 0), MAX_REACTORS_PER_EMOJI);
    for (let n = 1; n <= others; n++) out.push({ remoteId, reactor: `telegram:${emoji}:${n}`, emoji });
  }
  if (out.length > 0) out[0] = { ...out[0], replaceAll: true };
  return out;
}

/** One message, or null for a service notice (joins, pins, title changes). */
/**
 * The named people in a message: `text_mention` entities (a person without a handle, named by
 * id). A plain `@username` mention is a handle in the text, not an id, so it stays plain text.
 */
export function mentionsOf(message: TgMessage, selfId: number | null): Mention[] | undefined {
  const found: Mention[] = [];
  for (const e of message.entities ?? []) {
    const userId = e.params?.userId;
    if (e.kind !== 'text_mention' || typeof userId !== 'number') continue;
    const range = { start: e.offset, end: e.offset + e.length, userId: String(userId) };
    found.push(userId === selfId ? { ...range, self: true } : range);
  }
  return normalizeMentions(message.text, found);
}

export function toChatMessage(message: TgMessage, selfId: number | null = null): ChatMessage | null {
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
    mentions: mentionsOf(message, selfId),
    hasAttachments: message.media !== null && FILE_MEDIA.has(message.media.type),
    attachments: toChatAttachments(message),
    replyToRemoteId: reply?.id ? remoteMessageId(chatId, reply.id) : null,
    threadRemoteId:
      message.isTopicMessage && reply?.threadId ? remoteMessageId(chatId, reply.threadId) : null,
    groupId: message.groupedIdUnique ?? null,
  };
}
