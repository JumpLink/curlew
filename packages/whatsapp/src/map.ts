/**
 * Baileys' events → the network-neutral `DeliveryEvent`s of `@curlew/protocol`.
 *
 * Pure: it reads the structural shapes in `api.ts` and keeps only a `JidResolver`, so every rule
 * here is tested against synthetic events on both runtimes.
 *
 * What is kept: what a person wrote (text, captions, a poll's question, a shared contact's or
 * place's name), that a file came with it, the reply it answers, edits and deletions, who read
 * what. What is dropped: notices (joins, "this message was deleted" placeholders), reactions,
 * protocol housekeeping, and status updates (`status@broadcast`: other people's stories).
 */

import { Buffer } from 'node:buffer';
import type { AttachmentKind, ChatAttachment, ChatMessage, DeliveryEvent } from '@curlew/protocol';
import type {
  WaChat,
  WaContact,
  WaEventMap,
  WaGroup,
  WaMessage,
  WaMedia,
  WaMediaType,
  WaMessageContent,
  WaMessageKey,
} from './api.ts';
import { toNumber } from './api.ts';
import { chatKindOf, JidResolver, parseJid, STATUS_BROADCAST } from './jid.ts';

const REVOKE = 0;
const MESSAGE_EDIT = 14;
const STATUS_READ = 4;

/** Peel the wrappers (disappearing, view-once, captioned document, edit, own-device copy) off. */
export function unwrapContent(content: WaMessageContent | null | undefined): WaMessageContent | null {
  let current = content ?? null;
  for (let depth = 0; current && depth < 8; depth++) {
    const inner =
      current.ephemeralMessage?.message ??
      current.viewOnceMessage?.message ??
      current.viewOnceMessageV2?.message ??
      current.viewOnceMessageV2Extension?.message ??
      current.documentWithCaptionMessage?.message ??
      current.editedMessage?.message ??
      current.deviceSentMessage?.message;
    if (!inner) break;
    current = inner;
  }
  return current;
}

export interface ExtractedContent {
  text: string | null;
  hasAttachments: boolean;
  /** The id of the message this one replies to, within the same chat. */
  replyTo: string | null;
}

const MEDIA = [
  'imageMessage',
  'videoMessage',
  'ptvMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
] as const;

const MEDIA_TYPES: Record<(typeof MEDIA)[number], WaMediaType> = {
  imageMessage: 'image',
  videoMessage: 'video',
  ptvMessage: 'ptv',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

/** What a download needs, kept in the index: the key and the CDN pointer, never shown or logged. */
export interface WaAttachmentHandle {
  type: WaMediaType;
  /** Base64. */
  mediaKey: string;
  directPath: string | null;
  url: string | null;
  /** Base64 SHA-256 of the plaintext, when the sender announced one. */
  sha256: string | null;
  length: number | null;
}

export function attachmentHandle(handle: WaAttachmentHandle): string {
  return JSON.stringify(handle);
}

const isMediaType = (value: unknown): value is WaMediaType =>
  typeof value === 'string' && (Object.values(MEDIA_TYPES) as string[]).includes(value);

const strOrNull = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' ? value : undefined;

/** What a stored handle names, or null when it is not one this backend wrote. */
export function parseAttachmentHandle(handle: string): WaAttachmentHandle | null {
  try {
    const value: unknown = JSON.parse(handle);
    if (typeof value !== 'object' || value === null) return null;
    const { type, mediaKey, directPath, url, sha256, length } = value as Record<string, unknown>;
    if (!isMediaType(type) || typeof mediaKey !== 'string' || mediaKey === '') return null;
    const path = strOrNull(directPath);
    const link = strOrNull(url);
    const digest = strOrNull(sha256);
    if (path === undefined || link === undefined || digest === undefined) return null;
    if (path === null && link === null) return null;
    if (length !== null && (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)) return null;
    return { type, mediaKey, directPath: path, url: link, sha256: digest, length };
  } catch {
    return null;
  }
}

function attachmentKind(type: WaMediaType, media: WaMedia): AttachmentKind {
  if (type === 'audio') return media.ptt === true ? 'voice' : 'audio';
  if (type === 'image' || type === 'sticker') return 'image';
  if (type === 'video' || type === 'ptv') return 'video';
  return media.mimetype?.startsWith('image/') ? 'image' : 'file';
}

const positive = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/**
 * The files a message carries, as far as they can be fetched later: a media message without a
 * key or without a CDN pointer (a contact card, a malformed one) gets no row, so the UI never
 * offers a tap that cannot succeed.
 */
export function extractAttachments(content: WaMessageContent | null): ChatAttachment[] {
  if (!content) return [];
  const out: ChatAttachment[] = [];
  for (const field of MEDIA) {
    const media = content[field];
    if (!media?.mediaKey?.byteLength || (!media.directPath && !media.url)) continue;
    const type = MEDIA_TYPES[field];
    const length = toNumber(media.fileLength);
    const seconds = positive(media.seconds);
    out.push({
      filename: type === 'document' ? (media.fileName ?? null) : null,
      mimeType: media.mimetype ?? null,
      size: length,
      kind: attachmentKind(type, media),
      width: positive(media.width),
      height: positive(media.height),
      durationMs: seconds === null ? null : seconds * 1000,
      handle: attachmentHandle({
        type,
        mediaKey: Buffer.from(media.mediaKey).toString('base64'),
        directPath: media.directPath ?? null,
        url: media.url ?? null,
        sha256: media.fileSha256?.byteLength ? Buffer.from(media.fileSha256).toString('base64') : null,
        length,
      }),
    });
  }
  return out;
}

/** What a person wrote, or null for content that is not a message (a reaction, housekeeping). */
export function extractContent(content: WaMessageContent | null): ExtractedContent | null {
  if (!content) return null;
  let text: string | null = content.conversation ?? content.extendedTextMessage?.text ?? null;
  let replyTo = content.extendedTextMessage?.contextInfo?.stanzaId ?? null;
  let hasAttachments = false;
  for (const kind of MEDIA) {
    const media = content[kind];
    if (!media) continue;
    hasAttachments = true;
    // A document's file name is what a list shows when there is no caption.
    text ??= media.caption ?? (kind === 'documentMessage' ? (media.fileName ?? null) : null);
    replyTo ??= media.contextInfo?.stanzaId ?? null;
  }
  if (content.contactMessage) {
    // A shared contact card (vCard) is a file in all but name.
    hasAttachments = true;
    text ??= content.contactMessage.displayName ?? null;
    replyTo ??= content.contactMessage.contextInfo?.stanzaId ?? null;
  }
  if (content.contactsArrayMessage) {
    hasAttachments = true;
    text ??= content.contactsArrayMessage.displayName ?? null;
  }
  const location = content.locationMessage;
  if (location) {
    const place = [location.name, location.address].filter(Boolean).join(', ');
    const geo =
      typeof location.degreesLatitude === 'number' && typeof location.degreesLongitude === 'number'
        ? `geo:${location.degreesLatitude},${location.degreesLongitude}`
        : null;
    text ??= place || geo;
  }
  const poll = content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3;
  if (poll) text ??= poll.name ?? null;
  if (!text?.trim() && !hasAttachments) return null;
  return { text: text?.trim() ? text : null, hasAttachments, replyTo: replyTo || null };
}

function iso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

/**
 * The network message id. WhatsApp's id alone — not prefixed with the chat — so that a chat
 * merged from its phone-number id into its LID keeps its messages' ids; the store keys a row by
 * chat AND id, so two chats cannot collide.
 */
export function remoteMessageId(messageId: string): string {
  return messageId;
}

/** Turns Baileys' events into delivery events, learning JID pairs as it goes. */
export class WhatsAppMapper {
  readonly resolver: JidResolver;

  constructor(resolver: JidResolver = new JidResolver()) {
    this.resolver = resolver;
  }

  /**
   * A `chat-merged` event for every LID ↔ phone pair learned since the last call: the direct
   * chat filed under the number (before the LID was known) joins the one under the LID. The
   * store ignores a merge whose source chat it does not have, so most of these cost nothing.
   */
  takeMerges(): DeliveryEvent[] {
    return this.resolver.takeLearned().map(({ pn, lid }) => ({
      type: 'chat-merged',
      from: `${pn}@s.whatsapp.net`,
      into: `${lid}@lid`,
    }));
  }

  /** The chat a key belongs to, or null for status updates and ids that are no chat. */
  private chatOf(key: WaMessageKey): string | null {
    if (!key.remoteJid || key.remoteJid === STATUS_BROADCAST) return null;
    return this.resolver.chatId(key.remoteJid, key.remoteJidAlt);
  }

  /**
   * One message as the events it amounts to: a `message`, or an `edit` / `delete` when it is a
   * protocol message about another one, or nothing.
   */
  message(raw: WaMessage, seen: boolean): DeliveryEvent[] {
    const key = raw.key;
    const chatId = this.chatOf(key);
    const chatJid = parseJid(key.remoteJid);
    if (!chatId || !chatJid || !key.id) return [];
    const content = unwrapContent(raw.message);
    const protocol = content?.protocolMessage;
    if (protocol) {
      const target = protocol.key?.id;
      if (!target) return [];
      if (protocol.type === REVOKE)
        return [{ type: 'delete', chatRemoteId: chatId, remoteId: remoteMessageId(target) }];
      if (protocol.type === MESSAGE_EDIT) {
        const edited = extractContent(unwrapContent(protocol.editedMessage));
        const ms = toNumber(protocol.timestampMs);
        const at = ms !== null ? new Date(ms).toISOString() : iso(toNumber(raw.messageTimestamp));
        return [
          {
            type: 'edit',
            chatRemoteId: chatId,
            remoteId: remoteMessageId(target),
            text: edited?.text ?? null,
            editedAt: at,
          },
        ];
      }
      return [];
    }
    if (raw.messageStubType) return [];
    const extracted = extractContent(content);
    if (!extracted) return [];
    const attachments = extractAttachments(content);

    const kind = chatKindOf(chatJid);
    const fromSelf = key.fromMe === true;
    const sender = fromSelf
      ? null
      : kind === 'direct'
        ? this.resolver.peer(key.remoteJid, key.remoteJidAlt, raw.pushName ?? null)
        : key.participant
          ? this.resolver.peer(key.participant, key.participantAlt, raw.pushName ?? null)
          : null;
    const seconds = toNumber(raw.messageTimestamp);
    const message: ChatMessage = {
      remoteId: remoteMessageId(key.id),
      seq: seconds ?? 0,
      sentAt: iso(seconds),
      editedAt: null,
      sender,
      fromSelf,
      text: extracted.text,
      hasAttachments: extracted.hasAttachments,
      attachments: attachments.length > 0 ? attachments : undefined,
      replyToRemoteId: extracted.replyTo ? remoteMessageId(extracted.replyTo) : null,
      threadRemoteId: null,
      // For our own messages the id IS the id the sender gave it: Baileys generates it before the
      // stanza leaves, and `send.ts` returns the same one. The engine recognises the copy that
      // comes back by it and drops the local echo written at send time, instead of showing two.
      clientId: fromSelf ? remoteMessageId(key.id) : null,
    };
    const events: DeliveryEvent[] = [
      { type: 'message', chatRemoteId: chatId, chatKind: kind, message, seen: fromSelf || seen },
    ];
    if (fromSelf && (raw.status ?? 0) >= STATUS_READ) {
      events.push({ type: 'peer-read', chatRemoteId: chatId, remoteIds: [message.remoteId] });
    }
    return events;
  }

  /** A chat report. `unreadCount` is honoured only when `absolute` (a history sync). */
  chat(raw: WaChat, absolute: boolean): DeliveryEvent[] {
    this.resolver.learn(raw.pnJid, raw.lidJid);
    this.resolver.learn(raw.id, raw.lidJid ?? raw.pnJid);
    const jid = parseJid(raw.id);
    if (!jid || raw.id === STATUS_BROADCAST) return [];
    const chatId = this.resolver.chatId(raw.id, raw.lidJid ?? raw.pnJid);
    if (!chatId) return [];
    const kind = chatKindOf(jid);
    const title = raw.name?.trim() || raw.displayName?.trim() || null;
    const peer = kind === 'direct' ? this.resolver.peer(raw.id, raw.lidJid ?? raw.pnJid, title) : null;
    const events: DeliveryEvent[] = [
      { type: 'chat', chat: { remoteId: chatId, kind, title, members: peer ? [peer] : null } },
    ];
    const unread = raw.unreadCount;
    // In an update, 0 is "read on another device"; a positive count is an increment Baileys
    // computed itself and -1 "marked as unread" — neither is a read state to copy.
    if (typeof unread === 'number' && unread >= 0 && (absolute || unread === 0)) {
      events.push({ type: 'chat-read', chatRemoteId: chatId, unreadCount: unread });
    }
    return events;
  }

  contact(raw: Partial<WaContact>): DeliveryEvent[] {
    this.resolver.learn(raw.id, raw.lid ?? raw.phoneNumber);
    if (raw.lid && raw.phoneNumber) this.resolver.learn(raw.lid, raw.phoneNumber);
    const name = raw.name?.trim() || raw.notify?.trim() || raw.verifiedName?.trim() || null;
    const peer = this.resolver.peer(raw.id, raw.lid ?? raw.phoneNumber, name);
    return peer ? [{ type: 'peer', peer }] : [];
  }

  group(raw: Partial<WaGroup>): DeliveryEvent[] {
    const jid = parseJid(raw.id);
    if (!jid || !raw.id) return [];
    const members = raw.participants
      ?.map((p) => this.resolver.peer(p.id, p.lid ?? p.phoneNumber ?? null, null))
      .filter((p) => p !== null);
    if (raw.subject === undefined && !members) return [];
    return [
      {
        type: 'chat',
        chat: {
          remoteId: `${jid.user}@${jid.server}`,
          kind: chatKindOf(jid),
          title: raw.subject?.trim() || null,
          members: members ?? null,
        },
      },
    ];
  }

  /** A history-sync chunk: pairs and contacts first, so the messages resolve to one identity. */
  history(set: WaEventMap['messaging-history.set']): DeliveryEvent[] {
    for (const m of set.lidPnMappings ?? []) this.resolver.learn(m.lid, m.pn);
    const events: DeliveryEvent[] = [];
    for (const c of set.contacts) events.push(...this.contact(c));
    const reads: DeliveryEvent[] = [];
    for (const chat of set.chats) {
      for (const e of this.chat(chat, true)) (e.type === 'chat-read' ? reads : events).push(e);
    }
    // History arrives newest first; stored oldest first reads better in a log and changes nothing else.
    for (const m of [...set.messages].reverse()) events.push(...this.message(m, true));
    // The read state last: it counts the messages just written.
    events.push(...reads);
    return events;
  }

  /** Receipts on the user's own messages: the other side read (or played) them. */
  receipts(updates: WaEventMap['messages.update']): DeliveryEvent[] {
    const events: DeliveryEvent[] = [];
    for (const { key, update } of updates) {
      if (!key.fromMe || !key.id || (update.status ?? 0) < STATUS_READ) continue;
      const chatId = this.chatOf(key);
      if (chatId)
        events.push({
          type: 'peer-read',
          chatRemoteId: chatId,
          remoteIds: [remoteMessageId(key.id)],
        });
    }
    return events;
  }

  userReceipts(updates: WaEventMap['message-receipt.update']): DeliveryEvent[] {
    const events: DeliveryEvent[] = [];
    for (const { key, receipt } of updates) {
      if (!key.fromMe || !key.id) continue;
      if (toNumber(receipt.readTimestamp) === null && toNumber(receipt.playedTimestamp) === null) continue;
      const chatId = this.chatOf(key);
      if (chatId)
        events.push({
          type: 'peer-read',
          chatRemoteId: chatId,
          remoteIds: [remoteMessageId(key.id)],
        });
    }
    return events;
  }

  /** "Delete for me" on another device, or "clear chat". */
  deletion(data: WaEventMap['messages.delete']): DeliveryEvent[] {
    if ('all' in data) {
      const chatId = this.chatOf({ remoteJid: data.jid });
      return chatId ? [{ type: 'chat-cleared', chatRemoteId: chatId }] : [];
    }
    const events: DeliveryEvent[] = [];
    for (const key of data.keys) {
      const chatId = this.chatOf(key);
      if (chatId && key.id)
        events.push({ type: 'delete', chatRemoteId: chatId, remoteId: remoteMessageId(key.id) });
    }
    return events;
  }

  chatDeletion(ids: string[]): DeliveryEvent[] {
    const events: DeliveryEvent[] = [];
    for (const id of ids) {
      const chatId = this.chatOf({ remoteJid: id });
      if (chatId) events.push({ type: 'chat-deleted', chatRemoteId: chatId });
    }
    return events;
  }
}
