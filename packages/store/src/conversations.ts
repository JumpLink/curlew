/**
 * Conversations, participants and their messages — read by the CLI and MCP.
 *
 * The writes here are small single-row updates (`deleteOwnMessage`, `setMessageText`,
 * `setOwnReaction`). The bulk rebuild that rewrites the mail-derived tables lives in
 * `conversations-rebuild.ts` and is re-exported from here so importers stay unchanged.
 *
 * The reads apply the user's per-sender overrides at query time. They come from the config, not
 * the index, so correcting a sender never writes here — only `curlew sync` does.
 */

import type {
  Classification,
  ClassificationReason,
  Conversation,
  ConversationMessage,
  MessageRef,
  Participant,
  ParticipantAddress,
} from '@curlew/protocol';
import { conversationVerdict, type MessageVerdict, type SenderOverrides } from './classify.ts';
import type { IndexDatabase } from './db.ts';
import { placeholders, seqColumn } from './db.ts';
import { messageBody } from './index-store.ts';
import { parseParticipantAddresses, str, tri } from './row.ts';
import { MAIL_BACKEND, PENDING_DELETE, setOwnReaction } from './conversations-shared.ts';
export { setOwnReaction };
export { rebuildConversations, type RebuildOptions, type RebuildResult } from './conversations-rebuild.ts';

// ── reads ──────────────────────────────────────────────────────────────

export interface ConversationQuery {
  /** Only conversations with a person in them (ADR 0001: `--people-only`). */
  peopleOnly?: boolean;
  accountId?: string;
  /** Accounts left out (paused ones): `account_id NOT IN (...)`. */
  excludeAccounts?: readonly string[];
  /** Accounts that show only email chats (plain mail switched off): their other mail threads are left out. */
  chatOnlyAccounts?: readonly string[];
  backend?: string;
  /** Every protocol but this one: a window lists chats whole and mail by its own limit. */
  excludeBackend?: string;
  /** Only mail threads that are email chats (Chat-Version), so newsletters do not fill the limit. */
  emailChat?: boolean;
  limit?: number;
  /** Rows to skip, for reading a long list in slices. */
  offset?: number;
  /** Per-sender corrections, keyed by normalized address. */
  overrides?: SenderOverrides;
}

const DEFAULT_LIST_LIMIT = 50;

/**
 * The SQL twin of `conversationVerdict`: a conversation is conversational when no one else
 * wrote in it, or when some message from someone else is conversational after overrides.
 * Kept next to that function's contract; the tests pin that both agree.
 */
function peopleOnlyClause(overrides: SenderOverrides): { sql: string; params: string[] } {
  const forced = Object.entries(overrides);
  const toConversational = forced.filter(([, c]) => c === 'conversational').map(([a]) => a);
  const toAutomated = forced.filter(([, c]) => c === 'automated').map(([a]) => a);

  const messageConditions: string[] = [];
  const params: string[] = [];
  if (toConversational.length > 0) {
    messageConditions.push(`sender_address IN (${placeholders(toConversational.length)})`);
    params.push(...toConversational);
  }
  if (toAutomated.length > 0) {
    // NULL-safe: `NULL NOT IN (…)` is NULL, which would silently drop every sender-less row.
    messageConditions.push(
      `(classification = 'conversational' AND (sender_address IS NULL OR sender_address NOT IN (${placeholders(toAutomated.length)})))`,
    );
    params.push(...toAutomated);
  } else {
    messageConditions.push(`classification = 'conversational'`);
  }

  return {
    sql:
      `(id IN (SELECT conversation_id FROM conversation_messages WHERE from_self = 0 AND (${messageConditions.join(' OR ')}))` +
      ` OR id NOT IN (SELECT conversation_id FROM conversation_messages WHERE from_self = 0))`,
    params,
  };
}

function loadParticipants(db: IndexDatabase, conversationIds: string[]): Map<string, Participant[]> {
  const result = new Map<string, Participant[]>();
  if (conversationIds.length === 0) return result;
  const rows = db
    .prepare(
      `SELECT cp.conversation_id, p.id, p.display_name, p.contact_uid
         FROM conversation_participants cp JOIN participants p ON p.id = cp.participant_id
        WHERE cp.conversation_id IN (${placeholders(conversationIds.length)})
        ORDER BY p.display_name, p.id`,
    )
    .all(...conversationIds) as Array<Record<string, unknown>>;
  const participantIds = [...new Set(rows.map((r) => String(r.id)))];
  const addresses = new Map<string, ParticipantAddress[]>();
  if (participantIds.length > 0) {
    const addressRows = db
      .prepare(
        `SELECT participant_id, kind, value FROM participant_addresses
          WHERE participant_id IN (${placeholders(participantIds.length)}) ORDER BY kind, value`,
      )
      .all(...participantIds) as Array<Record<string, unknown>>;
    for (const a of addressRows) {
      const list = addresses.get(String(a.participant_id)) ?? [];
      list.push({ kind: String(a.kind) as ParticipantAddress['kind'], value: String(a.value) });
      addresses.set(String(a.participant_id), list);
    }
  }
  for (const r of rows) {
    const id = String(r.id);
    const list = result.get(String(r.conversation_id)) ?? [];
    list.push({
      id,
      displayName: str(r.display_name),
      contactUid: str(r.contact_uid),
      addresses: addresses.get(id) ?? [],
    });
    result.set(String(r.conversation_id), list);
  }
  return result;
}

function loadVerdicts(db: IndexDatabase, conversationIds: string[]): Map<string, MessageVerdict[]> {
  const result = new Map<string, MessageVerdict[]>();
  if (conversationIds.length === 0) return result;
  // The verdict depends on which combinations occur, not on how often: DISTINCT hands over a few
  // thousand rows instead of every message of every chat (44 000 rows cost half a second on GJS).
  const rows = db
    .prepare(
      `SELECT DISTINCT conversation_id, from_self, sender_address, classification, classification_reason
         FROM conversation_messages WHERE conversation_id IN (${placeholders(conversationIds.length)})`,
    )
    .all(...conversationIds) as Array<Record<string, unknown>>;
  for (const r of rows) {
    const list = result.get(String(r.conversation_id)) ?? [];
    list.push({
      fromSelf: Number(r.from_self) === 1,
      senderAddress: str(r.sender_address),
      classification: String(r.classification) as Classification,
      reason: String(r.classification_reason) as ClassificationReason,
    });
    result.set(String(r.conversation_id), list);
  }
  return result;
}

/**
 * The directory participants a send target belongs to: whoever holds the address (an e-mail
 * address in any case), plus the participant a chat peer of this account resolved to. Empty when
 * the index does not know the target; callers treat that as "not a known person".
 */
export function participantIdsOfTarget(
  db: IndexDatabase,
  backend: string,
  accountId: string,
  target: string,
): string[] {
  const values = [...new Set([target, target.toLowerCase()])];
  const ids = new Set<string>();
  for (const value of values) {
    const owners = db
      .prepare(`SELECT participant_id FROM participant_addresses WHERE value = ?`)
      .all(value) as Array<{ participant_id: unknown }>;
    for (const row of owners) ids.add(String(row.participant_id));
    const linked = db
      .prepare(
        `SELECT participant_id FROM chat_peer_links WHERE backend = ? AND account_id = ? AND peer_id = ?`,
      )
      .all(backend, accountId, value) as Array<{ participant_id: unknown }>;
    for (const row of linked) ids.add(String(row.participant_id));
  }
  return [...ids].sort();
}

/**
 * The address values of every participant in the conversation a message belongs to, one list per
 * participant (a person with several addresses stays together).
 *
 * This is what the read-access gate needs for `message_save_attachment`: a contact whose
 * conversation is closed may not be read through their pictures either. An unknown message
 * returns an empty list, which leaves the gate to refuse.
 */
export function messageParticipantAddresses(db: IndexDatabase, ref: MessageRef): string[][] {
  const row = db
    .prepare(
      `SELECT conversation_id FROM conversation_messages
        WHERE backend = ? AND account_id = ?
          AND (remote_id = ? OR (folder_path = ? AND uid = ?))`,
    )
    .get(
      ref.backend,
      ref.accountId,
      ref.remoteId ?? null,
      ref.folder ?? null,
      ref.uid ?? null,
    ) as { conversation_id?: unknown } | undefined;
  const conversationId = row?.conversation_id;
  if (conversationId === undefined || conversationId === null) return [];
  const participantRows = db
    .prepare(
      `SELECT p.id FROM conversation_participants cp
         JOIN participants p ON p.id = cp.participant_id
        WHERE cp.conversation_id = ?`,
    )
    .all(String(conversationId)) as Array<{ id: unknown }>;
  if (participantRows.length === 0) return [];
  const ids = participantRows.map((r) => String(r.id));
  const addressRows = db
    .prepare(
      `SELECT participant_id, value FROM participant_addresses
        WHERE participant_id IN (${placeholders(ids.length)})`,
    )
    .all(...ids) as Array<{ participant_id: unknown; value: unknown }>;
  return ids
    .map((id) => addressRows.filter((r) => String(r.participant_id) === id).map((r) => String(r.value)))
    .filter((addresses) => addresses.length > 0);
}

function presentationOf(value: unknown): ConversationMessage['presentation'] {
  const v = String(value);
  return v === 'bubble' || v === 'notice' ? v : 'document';
}

function rowToConversation(
  r: Record<string, unknown>,
  participants: Participant[],
  verdict: { classification: Classification; reason: ClassificationReason },
): Conversation {
  return {
    id: String(r.id),
    backend: String(r.backend),
    accountId: String(r.account_id),
    kind: String(r.kind) === 'group' ? 'group' : 'direct',
    title: str(r.title),
    participants,
    classification: verdict.classification,
    classificationReason: verdict.reason,
    firstMessageAt: str(r.first_message_at),
    lastMessageAt: str(r.last_message_at),
    messageCount: Number(r.message_count),
    unreadCount: Number(r.unread_count),
    hasAttachments: Number(r.has_attachments) === 1,
    emailChat: Number(r.email_chat) === 1,
  };
}

const CONVERSATION_COLUMNS = `id, backend, account_id, kind, title, first_message_at, last_message_at,
  message_count, unread_count, has_attachments, email_chat`;

function hydrate(
  db: IndexDatabase,
  rows: Array<Record<string, unknown>>,
  overrides: SenderOverrides,
): Conversation[] {
  const ids = rows.map((r) => String(r.id));
  const participants = loadParticipants(db, ids);
  const verdicts = loadVerdicts(db, ids);
  return rows.map((r) =>
    rowToConversation(
      r,
      participants.get(String(r.id)) ?? [],
      conversationVerdict(verdicts.get(String(r.id)) ?? [], overrides),
    ),
  );
}

/** Conversations, newest first. */
export function listConversations(db: IndexDatabase, query: ConversationQuery = {}): Conversation[] {
  const overrides = query.overrides ?? {};
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (query.accountId) {
    where.push('account_id = ?');
    params.push(query.accountId);
  }
  if (query.excludeAccounts && query.excludeAccounts.length > 0) {
    where.push(`account_id NOT IN (${placeholders(query.excludeAccounts.length)})`);
    params.push(...query.excludeAccounts);
  }
  if (query.chatOnlyAccounts && query.chatOnlyAccounts.length > 0) {
    where.push(`(backend <> 'mail' OR email_chat = 1 OR account_id NOT IN (${placeholders(query.chatOnlyAccounts.length)}))`);
    params.push(...query.chatOnlyAccounts);
  }
  if (query.backend) {
    where.push('backend = ?');
    params.push(query.backend);
  }
  if (query.excludeBackend) {
    where.push('backend <> ?');
    params.push(query.excludeBackend);
  }
  if (query.emailChat) where.push('email_chat = 1');
  if (query.peopleOnly) {
    const clause = peopleOnlyClause(overrides);
    where.push(clause.sql);
    params.push(...clause.params);
  }
  const rows = db
    .prepare(
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY last_message_at DESC, id LIMIT ? OFFSET ?`,
    )
    .all(...params, query.limit ?? DEFAULT_LIST_LIMIT, query.offset ?? 0) as Array<Record<string, unknown>>;
  return hydrate(db, rows, overrides);
}

/**
 * The newest message of a conversation, reduced to what a list row shows. This is for the window
 * only: it carries a body, so it never goes into `Conversation` or any agent-facing DTO.
 */
export interface MessagePreview {
  conversationId: string;
  sentAt: string | null;
  fromSelf: boolean;
  /** The start of a chat body, cut in SQL; null for mail, whose body lives in the full-text index. */
  body: string | null;
  subject: string | null;
  hasAttachments: boolean;
  senderName: string | null;
}

const PREVIEW_BODY_CHARS = 300;
const PREVIEW_CHUNK = 400;

/** The newest message of each given conversation; a conversation with none is left out. */
export function latestMessagePreviews(
  db: IndexDatabase,
  conversationIds: readonly string[],
): Map<string, MessagePreview> {
  const found = new Map<string, MessagePreview>();
  for (let i = 0; i < conversationIds.length; i += PREVIEW_CHUNK) {
    const chunk = conversationIds.slice(i, i + PREVIEW_CHUNK);
    const rows = db
      .prepare(
        `SELECT m.conversation_id, m.sent_at, m.from_self, substr(m.body, 1, ${PREVIEW_BODY_CHARS}) AS body,
                m.subject, m.has_attachments,
                COALESCE(NULLIF(m.sender_name, ''), (SELECT p.display_name FROM chat_peers p
                  WHERE p.backend = m.backend AND p.account_id = m.account_id
                    AND p.peer_id = m.sender_peer_id)) AS sender_name
           FROM conversation_messages m
          WHERE m.conversation_id IN (${chunk.map(() => '?').join(',')})
            AND m.rowid = (SELECT n.rowid FROM conversation_messages n
                            WHERE n.conversation_id = m.conversation_id
                            ORDER BY n.sent_at DESC, n.rowid DESC LIMIT 1)`,
      )
      .all(...chunk) as Array<Record<string, unknown>>;
    for (const r of rows) {
      found.set(String(r.conversation_id), {
        conversationId: String(r.conversation_id),
        sentAt: str(r.sent_at),
        fromSelf: Number(r.from_self) === 1,
        body: str(r.body),
        subject: str(r.subject),
        hasAttachments: Number(r.has_attachments) === 1,
        senderName: str(r.sender_name),
      });
    }
  }
  return found;
}

/** A chat message that contains the searched text, as one line around the match. */
export interface TextHit {
  conversationId: string;
  sentAt: string | null;
  snippet: string;
}

const HIT_LEAD_CHARS = 30;
const HIT_CHARS = 150;
const HIT_SCAN_LIMIT = 1000;

/**
 * The newest message per conversation whose body or subject contains `text`, newest first. SQLite
 * folds only ASCII case, so "ä" does not match "Ä"; mail bodies are not here (they are in the
 * full-text index), only mail subjects. Window-only, like `latestMessagePreviews`.
 */
export function searchMessageText(db: IndexDatabase, text: string): TextHit[] {
  const needle = text.trim();
  if (needle === '') return [];
  const pattern = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = db
    .prepare(
      `SELECT conversation_id, sent_at, subject,
              substr(body, max(1, instr(lower(body), lower(?)) - ${HIT_LEAD_CHARS}), ${HIT_CHARS}) AS around
         FROM conversation_messages
        WHERE body LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\'
        ORDER BY sent_at DESC, id DESC LIMIT ${HIT_SCAN_LIMIT}`,
    )
    .all(needle, pattern, pattern) as Array<Record<string, unknown>>;
  const lower = needle.toLowerCase();
  const hits = new Map<string, TextHit>();
  for (const r of rows) {
    const id = String(r.conversation_id);
    if (hits.has(id)) continue;
    const around = str(r.around);
    const snippet = around !== null && around.toLowerCase().includes(lower) ? around : str(r.subject);
    if (snippet === null) continue;
    hits.set(id, { conversationId: id, sentAt: str(r.sent_at), snippet });
  }
  for (const hit of searchDraftBodies(db, needle, pattern)) if (!hits.has(hit.conversationId)) hits.set(hit.conversationId, hit);
  return [...hits.values()].sort((a, b) => (a.sentAt ?? '') < (b.sentAt ?? '') ? 1 : -1);
}

/**
 * Unsent drafts: mail in a folder with the `drafts` role. Their body sits in the full-text index
 * rather than on the message row, so the plain scan above misses it. Window-only, like the rest.
 */
function searchDraftBodies(db: IndexDatabase, needle: string, pattern: string): TextHit[] {
  const rows = db
    .prepare(
      `SELECT cm.conversation_id, cm.sent_at, cm.subject, substr(f.body, max(1, instr(lower(f.body), lower(?)) - ${HIT_LEAD_CHARS}), ${HIT_CHARS}) AS around
         FROM conversation_messages cm
         JOIN folders fo ON fo.account_id = cm.account_id AND fo.path = cm.folder_path AND fo.role = 'drafts'
         JOIN messages m ON m.account_id = cm.account_id AND m.folder_path = cm.folder_path AND m.uid = cm.uid
         JOIN messages_fts f ON f.rowid = m.id
        WHERE f.body LIKE ? ESCAPE '\\'
        ORDER BY cm.sent_at DESC, cm.id DESC LIMIT ${HIT_SCAN_LIMIT}`,
    )
    .all(needle, pattern) as Array<Record<string, unknown>>;
  const lower = needle.toLowerCase();
  const found: TextHit[] = [];
  for (const r of rows) {
    const around = str(r.around);
    const snippet = around !== null && around.toLowerCase().includes(lower) ? around : str(r.subject);
    if (snippet !== null) found.push({ conversationId: String(r.conversation_id), sentAt: str(r.sent_at), snippet });
  }
  return found;
}

export interface ConversationDetailOptions {
  /** Include each message's plain-text body. Off by default: bodies are other people's words. */
  includeBodies?: boolean;
  /** Per-message body cap when bodies are included. */
  maxBodyChars?: number;
  overrides?: SenderOverrides;
  /** Only messages sent strictly after this ISO 8601 time — how a consumer waits for a reply. */
  since?: string;
  /** Leave out the user's own messages. */
  incomingOnly?: boolean;
}

/** One conversation with its messages, oldest first. Null when the id is unknown. */
export function getConversation(
  db: IndexDatabase,
  id: string,
  options: ConversationDetailOptions = {},
): { conversation: Conversation; messages: ConversationMessage[] } | null {
  const overrides = options.overrides ?? {};
  const row = db.prepare(`SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const [conversation] = hydrate(db, [row], overrides);

  const rows = db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS}
         FROM conversation_messages WHERE conversation_id = ?${options.since ? ' AND sent_at > ?' : ''}${options.incomingOnly ? ' AND from_self = 0' : ''}
        ORDER BY sent_at, conversation_messages.remote_seq, id`,
    )
    .all(...(options.since ? [id, options.since] : [id])) as Array<Record<string, unknown>>;

  const messages = rows.map((r) => toMessage(db, r, options, overrides));
  attachReactions(db, messages);
  return { conversation, messages };
}

/** Where a page of history ends: the oldest message already shown. */
export interface MessageCursor {
  sentAt: string | null;
  id: string;
}

export interface RecentMessagesOptions {
  /** How many of the newest messages to return, across all the conversations together. */
  limit: number;
  /** Only messages strictly older than this one, in the (sent_at, id) order: the next page back. */
  before?: MessageCursor;
  includeBodies?: boolean;
  maxBodyChars?: number;
  overrides?: SenderOverrides;
}

/**
 * The newest messages of several conversations, oldest first, in one query. A person's direct mail
 * can span hundreds of threads; reading each in full would fetch every body, and a mail body is an
 * FTS lookup libgda runs twice. Only the `limit` messages returned have their body read.
 *
 * The order is (sent_at, id), a total order, so `before` pages through the history without a gap
 * or a repeat even where timestamps are equal. A NULL sent_at sorts first, as the oldest.
 */
export function getRecentMessages(
  db: IndexDatabase,
  ids: readonly string[],
  options: RecentMessagesOptions,
): ConversationMessage[] {
  if (ids.length === 0 || options.limit <= 0) return [];
  const before = options.before;
  const older = !before
    ? ''
    : before.sentAt === null
      ? ' AND sent_at IS NULL AND id < ?'
      : ' AND (sent_at < ? OR sent_at IS NULL OR (sent_at = ? AND id < ?))';
  const cursor = !before ? [] : before.sentAt === null ? [before.id] : [before.sentAt, before.sentAt, before.id];
  const rows = db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS}
         FROM conversation_messages WHERE conversation_id IN (${ids.map(() => '?').join(', ')})${older}
        ORDER BY sent_at DESC, id DESC LIMIT ?`,
    )
    .all(...ids, ...cursor, options.limit) as Array<Record<string, unknown>>;
  const messages = rows.reverse().map((r) => toMessage(db, r, options, options.overrides ?? {}));
  attachReactions(db, messages);
  return messages;
}

/**
 * The chat messages of `ids` whose network id is in `remoteIds`: what a reply quotes when the
 * quoted message is older than the page on screen. Same shape as {@link getRecentMessages}.
 */
export function getMessagesByRemoteId(
  db: IndexDatabase,
  ids: readonly string[],
  remoteIds: readonly string[],
  options: Pick<RecentMessagesOptions, 'includeBodies' | 'maxBodyChars' | 'overrides'> = {},
): ConversationMessage[] {
  if (ids.length === 0 || remoteIds.length === 0) return [];
  const found: ConversationMessage[] = [];
  const CHUNK = 200;
  for (let i = 0; i < remoteIds.length; i += CHUNK) {
    const slice = remoteIds.slice(i, i + CHUNK);
    const rows = db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}
           FROM conversation_messages
          WHERE conversation_id IN (${placeholders(ids.length)}) AND remote_seq IS NOT NULL
            AND remote_id IN (${placeholders(slice.length)})
          ORDER BY sent_at, id`,
      )
      .all(...ids, ...slice) as Array<Record<string, unknown>>;
    found.push(...rows.map((r) => toMessage(db, r, options, options.overrides ?? {})));
  }
  attachReactions(db, found);
  return found;
}

/** Fills `reactions` on the chat messages and email-chat mails among `messages`, one query for all of them. */
function attachReactions(db: IndexDatabase, messages: ConversationMessage[]): void {
  const chat = messages.filter((m) => m.editedAt !== undefined || m.emailChat);
  if (chat.length === 0) return;
  const byId = new Map(chat.map((m) => [m.id, m]));
  const ids = [...byId.keys()];
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = db
      .prepare(
        `SELECT message_id, emoji, COUNT(*) AS n, MAX(reactor = '') AS own, MIN(rowid) AS first
           FROM message_reactions WHERE message_id IN (${placeholders(slice.length)})
          GROUP BY message_id, emoji ORDER BY first`,
      )
      .all(...slice) as Array<{ message_id: unknown; emoji: unknown; n: unknown; own: unknown }>;
    for (const r of rows) {
      const message = byId.get(String(r.message_id));
      if (!message) continue;
      (message.reactions ??= []).push({ emoji: String(r.emoji), count: Number(r.n), own: Number(r.own) === 1 });
    }
  }
}

/**
 * Updates a message's body and edited timestamp. Returns true when the row existed and was
 * changed; false when the id was not a chat or email message.
 */
export function setMessageText(db: IndexDatabase, messageId: string, text: string): boolean {
  // A mail's edited text lives on its row too (the original stays in the FTS table).
  const result = db
    .prepare(
      "UPDATE conversation_messages SET body = ?, edited_at = ? WHERE id = ? AND (remote_seq IS NOT NULL OR backend = 'mail')",
    )
    .run(text, new Date().toISOString(), messageId);
  return result.changes > 0;
}

// A chat sender's name comes from the message row, else from the peer the network told us about
// later (Signal sends contact and profile names after the first group message).
const MESSAGE_COLUMNS = `id, conversation_id, backend, account_id, presentation, sender_participant_id,
              COALESCE(NULLIF(sender_name, ''), (SELECT p.display_name FROM chat_peers p
                WHERE p.backend = conversation_messages.backend AND p.account_id = conversation_messages.account_id
                  AND p.peer_id = conversation_messages.sender_peer_id)) AS sender_name,
              (SELECT p.addresses_json FROM chat_peers p
                WHERE p.backend = conversation_messages.backend AND p.account_id = conversation_messages.account_id
                  AND p.peer_id = conversation_messages.sender_peer_id) AS peer_addresses,
              sender_kind, sender_address, from_self, sent_at, subject, seen, has_attachments,
              classification, classification_reason, folder_path, uid, remote_id, email_chat, encrypted, ${seqColumn('remote_seq')}, body,
              edited_at, reply_to_remote_id, thread_remote_id, reply_to_client_id, group_id, client_id, peer_read`;

/** The phone number a chat peer is known by: shown when no name is, before an opaque id. */
function phoneOfPeer(json: unknown): string | null {
  if (typeof json !== 'string') return null;
  return parseParticipantAddresses(json).find((a) => a.kind === 'phone' && a.value)?.value ?? null;
}

function toMessage(
  db: IndexDatabase,
  r: Record<string, unknown>,
  options: { includeBodies?: boolean; maxBodyChars?: number },
  overrides: SenderOverrides,
): ConversationMessage {
  const senderAddress = str(r.sender_address);
  const forced = senderAddress && Number(r.from_self) !== 1 ? overrides[senderAddress] : undefined;
  const folder = str(r.folder_path);
  const uid = r.uid === null || r.uid === undefined ? undefined : Number(r.uid);
  const message: ConversationMessage = {
    id: String(r.id),
    conversationId: String(r.conversation_id),
    backend: String(r.backend),
    presentation: presentationOf(r.presentation),
    senderId: str(r.sender_participant_id),
    senderName: str(r.sender_name) ?? phoneOfPeer(r.peer_addresses),
    senderAddress:
      senderAddress && r.sender_kind
        ? { kind: String(r.sender_kind) as ParticipantAddress['kind'], value: senderAddress }
        : null,
    fromSelf: Number(r.from_self) === 1,
    sentAt: str(r.sent_at),
    subject: str(r.subject),
    seen: Number(r.seen) === 1,
    hasAttachments: Number(r.has_attachments) === 1,
    emailChat: Number(r.email_chat) === 1,
    ...(Number(r.encrypted) === 1 ? { encrypted: true } : {}),
    classification: forced ?? (String(r.classification) as Classification),
    classificationReason: forced ? 'override' : (String(r.classification_reason) as ClassificationReason),
    ref: {
      accountId: String(r.account_id),
      backend: String(r.backend),
      ...(folder ? { folder } : {}),
      ...(uid !== undefined ? { uid } : {}),
      ...(r.remote_id ? { remoteId: String(r.remote_id) } : {}),
    },
  };
  // Chat rows carry a sequence; their extra fields are set only for them, so a mail message
  // looks exactly as it did before chats existed.
  const chat = r.remote_seq !== null && r.remote_seq !== undefined;
  // A mail edited by a `Chat-Edit` keeps the new text on its row, and says when.
  const editedMail = !chat && r.edited_at !== null && r.edited_at !== undefined;
  if (editedMail) message.editedAt = str(r.edited_at);
  if (chat) {
    message.editedAt = str(r.edited_at);
    message.replyToRemoteId = str(r.reply_to_remote_id);
    message.replyToClientId = str(r.reply_to_client_id);
    message.threadRemoteId = str(r.thread_remote_id);
    message.groupId = str(r.group_id) || null;
    message.clientId = str(r.client_id);
    if (message.fromSelf) message.readByPeer = Number(r.peer_read) === 1;
  } else if (message.fromSelf && r.email_chat !== undefined && Number(r.email_chat) === 1) {
    message.readByPeer = Number(r.peer_read) === 1;
  }
  // A notice is what the network said about the chat: shown with or without bodies.
  if (message.presentation === 'notice') message.notice = str(r.body);
  if (options.includeBodies) {
    // Mail keeps its body once, in the FTS table; a chat message keeps it on its own row.
    const body =
      folder && uid !== undefined
        ? editedMail
          ? str(r.body)
          : messageBody(db, message.ref.accountId, folder, uid)
        : chat
          ? str(r.body)
          : null;
    const cap = options.maxBodyChars;
    message.bodyText = body !== null && cap !== undefined && body.length > cap ? body.slice(0, cap) : body;
    message.bodyTruncated = body !== null && cap !== undefined && body.length > cap;
  }
  return message;
}

/** What the index knows about the chat behind a conversation: where to address it and the room facts. */
export interface ChatRoomRow {
  /** The network's id for the chat (Matrix: the room id) — the address a send names. */
  chatId: string;
  /** NULL columns come back as null: the network did not say. */
  public: boolean | null;
  encrypted: boolean | null;
  memberCount: number | null;
}

/** The XEPs an XMPP peer advertised, by conversation id; a chat never asked is missing. */
export function listPeerFeatures(db: IndexDatabase, backend: string): Map<string, string[]> {
  const rows = db
    .prepare('SELECT conversation_id, peer_features FROM chat_cursors WHERE backend = ? AND peer_features IS NOT NULL')
    .all(backend) as Array<Record<string, unknown>>;
  const result = new Map<string, string[]>();
  for (const r of rows) {
    try {
      const parsed: unknown = JSON.parse(String(r.peer_features));
      if (Array.isArray(parsed)) result.set(String(r.conversation_id), parsed.map(String));
    } catch {
      // A damaged value is unknown, not "none".
    }
  }
  return result;
}

/** The chat rows of one backend by conversation id; empty for a backend with no chats. */
export function listChatRooms(db: IndexDatabase, backend: string): Map<string, ChatRoomRow> {
  const rows = db
    .prepare(
      'SELECT conversation_id, chat_id, room_public, room_encrypted, room_members FROM chat_cursors WHERE backend = ?',
    )
    .all(backend) as Array<Record<string, unknown>>;
  return new Map(
    rows.map((r) => [
      String(r.conversation_id),
      {
        chatId: String(r.chat_id),
        public: tri(r.room_public),
        encrypted: tri(r.room_encrypted),
        memberCount: r.room_members === null || r.room_members === undefined ? null : Number(r.room_members),
      },
    ]),
  );
}

/**
 * Hide a message the person deleted for everyone, at once. A mail row is also remembered as a
 * pending delete, so a rebuild before the `Chat-Delete` mail syncs back does not show it again.
 * Returns whether the message was found.
 */
export function deleteOwnMessage(db: IndexDatabase, messageId: string): boolean {
  const row = db
    .prepare(
      "SELECT backend, remote_id FROM conversation_messages WHERE id = ? AND (remote_seq IS NOT NULL OR backend = 'mail')",
    )
    .get(messageId) as Record<string, unknown> | undefined;
  if (!row) return false;
  if (row.backend === MAIL_BACKEND && row.remote_id) {
    db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run(
      `${PENDING_DELETE}${String(row.remote_id)}`,
      new Date().toISOString(),
    );
  }
  db.prepare('DELETE FROM conversation_messages WHERE id = ?').run(messageId);
  return true;
}
