/**
 * The chat sync engine — the `chat` driver's counterpart of `syncIndex`.
 *
 * Driven entirely through the `ChatBackend` port, so it runs on Node against a fake backend and
 * `:memory:`, exactly like the mail engine. It never names a network.
 *
 * Model (server archive, ADR 0001 §2): the network keeps the history, so the index holds a
 * window of it and can be rebuilt. The first sync of a chat takes its newest `historyDepth`
 * messages; every later sync walks FORWARD from the stored cursor, page by page, so nothing
 * between two syncs is skipped. Older history than the first window is not fetched.
 *
 * Deletions: an incremental run only walks forward, so it cannot see a message deleted on the
 * server — Telegram reports those only as live updates (per channel, through
 * `getChannelDifference`), which a sync without a daemon does not receive. A FULL SCAN
 * (`sync --full-scan`) re-takes each chat's newest window and removes every stored message in
 * the range that window covers but no longer contains, and every chat that left the list —
 * the chat counterpart of the mailbox engine's expunge pass. The window has a bottom, and the
 * index grows past it: below it the full scan asks the network about the stored ids themselves,
 * one bounded slice per run on a rotating sweep (`ChatSession.probeRetracted`, ADR 0004), for a
 * network that can be asked about a message BY ID.
 *
 * Budget: every message costs a share of a multi-row INSERT, which is a wide parse per few
 * rows rather than a statement each (see `insertMany` in `db.ts`). `maxMessages` caps one run; a
 * chat that did not fit keeps its cursor and
 * continues on the next run. Resumable by construction: the cursor is written in the same
 * transaction as the messages it covers.
 *
 * What happens after this: `rebuildConversations` links the chat peers written here to the
 * participant directory (address book first), set-based.
 */

import { isChatRateLimitedError } from '@curlew/protocol';
import type {
  ChatBackend,
  ChatEdit,
  ChatHistoryPage,
  ChatInfo,
  ChatMessage,
  ChatPeer,
  ChatSession,
  Classification,
  ClassificationReason,
} from '@curlew/protocol';
import type { IndexDatabase } from './db.ts';
import { appendChanges } from './changes.ts';
import { conversationTotalsSql } from './conversation-totals.ts';
import { insertMany, placeholders, seqColumn, type SqlValue, withTransaction } from './db.ts';
import { upsertAccount } from './index-store.ts';
import { LOCAL_ECHO_PREFIX } from './local-echo.ts';
import {
  LEASE_HEARTBEAT_MS,
  refreshReceiveLease,
  releaseReceiveLease,
  takeReceiveLease,
  type LeaseTake,
} from './receive-lease.ts';
import { stableId } from './threads.ts';

export interface ChatSyncOptions {
  /** Restrict to one account; omit for all. */
  accountId?: string;
  /** Messages taken on the FIRST sync of a chat. Older history stays on the server. */
  historyDepth?: number;
  /** Messages written in one run, across all chats; the rest continues next run. */
  maxMessages?: number;
  /** Messages per round trip when walking forward. */
  pageSize?: number;
  /** Re-fetch the newest window of every chat, picking up edits made since. */
  fullScan?: boolean;
  /** Stored ids one full scan asks about below the window, per chat (ADR 0004). */
  probeDepth?: number;
  /** Clock, injected so tests are deterministic. */
  now?: () => Date;
  /**
   * Take the receive lease (ADR 0002 §4) around each account, and stand down for one somebody
   * else holds — BEFORE connecting, so no client and no crypto store is opened. A bounded
   * `curlew sync` passes it; the daemon's own catch-up already holds the lease and does not.
   *
   * Why a chat backend needs it: a followed account is ONE device with ONE crypto store and ONE
   * to-device stream. A second client on it acknowledges half the room keys and writes the same
   * crypto snapshot from another process, last writer wins.
   */
  lease?: {
    /** Who holds it — the pid by default, as in the delivery path. */
    holder?: string;
    /** How often it is refreshed while the account syncs. Short only in tests. */
    intervalMs?: number;
  };
}

export interface ChatAccountSyncResult {
  backend: string;
  accountId: string;
  /** Chats the account has. */
  chats: number;
  /** Chats that had something new and were fetched. */
  chatsFetched: number;
  /** Messages written. */
  added: number;
  /** Messages and chats found deleted on the server by a full scan, and removed here. */
  removed: number;
  /** Chats whose fetch failed; their cursor stays where it was. */
  chatErrors: number;
  /**
   * What those chat errors were, by fixed category — never the network's own text, which can
   * quote a chat. `rate-limited` is a `ChatRateLimitedError`, `other` is everything else.
   */
  chatErrorKinds: { 'rate-limited': number; other: number };
  /**
   * Set when the network asked THIS account to wait (Telegram's FLOOD_WAIT_X): the run stopped
   * asking it — as with an exhausted budget — and `retryAfterMs` is when it may be asked again.
   * Every other account still ran. Null when the account was never throttled.
   */
  rateLimited: { retryAfterMs: number } | null;
  /** An error that stopped the whole account (connect, listing the chats). */
  error: string | null;
  /**
   * Another holder (a running daemon) receives this account: this run left it alone, which is a
   * success and not an error — the messages are arriving.
   */
  heldBy?: string;
  /** The lease could not be taken because the index was busy; nobody is known to hold it. */
  indexBusy?: true;
}

export interface ChatSyncResult {
  accounts: ChatAccountSyncResult[];
  added: number;
  removed: number;
  errors: number;
  /** True when EVERY account failed — the only case that is an error overall. */
  failed: boolean;
  /** True when `maxMessages` stopped the run before every chat was caught up. */
  budgetExhausted: boolean;
}

export const CHAT_HISTORY_DEPTH = 200;
export const CHAT_MAX_MESSAGES = 5_000;
/**
 * Stored messages one full scan asks a network about by id, per chat — two `getMessages` calls
 * for Telegram, which takes 100 ids each. The bound is what keeps the cost of a scan independent
 * of how large the index has grown; `probe_seq` is what still carries it to the oldest message.
 */
export const CHAT_PROBE_DEPTH = 200;
const DEFAULT_PAGE = 100;

interface Cursor {
  lastSeq: number | null;
  /** The archive's own id at `lastSeq`, for networks that page by id (null for the others). */
  lastCursor: string | null;
  readInboxSeq: number | null;
  readOutboxSeq: number | null;
  /**
   * How far the deletion sweep below the window got: the highest sequence it has already asked
   * about. NULL starts again at the chat's oldest stored message (ADR 0004).
   */
  probeSeq: number | null;
}

/** A tri-state flag as the column holds it: NULL = the network did not say. */
function flag(value: boolean | null | undefined): number | null {
  return value === null || value === undefined ? null : value ? 1 : 0;
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function loadCursors(db: IndexDatabase, backend: string, accountId: string): Map<string, Cursor> {
  const rows = db
    .prepare(
      `SELECT chat_id, ${seqColumn('last_seq')}, last_cursor, ${seqColumn('read_inbox_seq')}, ${seqColumn('read_outbox_seq')},
              ${seqColumn('probe_seq')}
         FROM chat_cursors WHERE backend = ? AND account_id = ?`,
    )
    .all(backend, accountId) as Array<Record<string, unknown>>;
  return new Map(
    rows.map((r) => [
      String(r.chat_id),
      {
        lastSeq: num(r.last_seq),
        lastCursor: r.last_cursor === null || r.last_cursor === undefined ? null : String(r.last_cursor),
        readInboxSeq: num(r.read_inbox_seq),
        readOutboxSeq: num(r.read_outbox_seq),
        probeSeq: num(r.probe_seq),
      },
    ]),
  );
}

/** The conversation id of a chat. Stable across syncs, so a copied id keeps resolving. */
export function chatConversationId(backend: string, accountId: string, chatRemoteId: string): string {
  return stableId('c-', backend, accountId, chatRemoteId);
}

/**
 * How one chat message is classified when it is written. `known-contact` is not decided here:
 * the address book can change without a new message, so `rebuildConversations` sets it.
 */
export function classifyChatMessage(
  chat: Pick<ChatInfo, 'kind'>,
  message: Pick<ChatMessage, 'fromSelf' | 'sender'>,
): { classification: Classification; reason: ClassificationReason } {
  if (message.fromSelf) return { classification: 'conversational', reason: 'self' };
  if (chat.kind === 'broadcast') return { classification: 'automated', reason: 'broadcast' };
  if (message.sender?.bot) return { classification: 'automated', reason: 'bot' };
  return { classification: 'conversational', reason: 'chat-member' };
}

/** Rows collected for one account, written in one transaction. */
class ChatBatch {
  readonly messages: SqlValue[][] = [];
  readonly peers = new Map<string, SqlValue[]>();
  readonly members = new Map<string, SqlValue[]>();
  readonly cursors: SqlValue[][] = [];
  readonly conversations: SqlValue[][] = [];
  /** Message rows whose message is gone from the server. */
  readonly deletedMessages: string[] = [];
  /** Chat conversations whose chat is gone from the account. */
  readonly deletedConversations: string[] = [];
  /**
   * Corrections of stored messages: text, time, conversation, remote id — and, for an edit that
   * names its sender, that sender twice (see `ChatEdit.senderRemoteId`; '' is the user).
   */
  readonly edits: SqlValue[][] = [];
  /** Messages stored by an earlier run that the network reports retracted: row ids. */
  readonly retracted: string[] = [];
  /**
   * The messages in this batch that carry a sender-given id, by that id: they replace curlew's
   * own local echoes. The row comes along because the echo may hold text the archive copy does
   * not — see {@link adoptEchoBody}.
   */
  readonly clientIds = new Map<string, SqlValue[]>();

  /**
   * The conversations this batch really changes, for the change journal (ADR 0007). Not derived
   * from `conversations` or `cursors`: a sync writes those for every chat it looked at.
   */
  readonly changed = new Set<string>();

  readonly backend: string;
  readonly accountId: string;

  constructor(backend: string, accountId: string) {
    this.backend = backend;
    this.accountId = accountId;
  }

  retract(conversationId: string, remoteId: string): void {
    this.retracted.push(stableId('m-', conversationId, remoteId));
    this.changed.add(conversationId);
  }

  edit(conversationId: string, edit: ChatEdit): void {
    this.changed.add(conversationId);
    const row: SqlValue[] = [edit.text, edit.editedAt, conversationId, edit.remoteId];
    if (edit.senderRemoteId !== undefined) row.push(edit.senderRemoteId ?? '', edit.senderRemoteId ?? '');
    this.edits.push(row);
  }

  peer(peer: ChatPeer): void {
    this.peers.set(peer.remoteId, [
      this.backend,
      this.accountId,
      peer.remoteId,
      peer.displayName,
      JSON.stringify(peer.addresses),
      peer.bot ? 1 : 0,
    ]);
  }

  member(conversationId: string, peer: ChatPeer): void {
    this.peer(peer);
    this.members.set(`${conversationId}\u0000${peer.remoteId}`, [
      conversationId,
      this.backend,
      this.accountId,
      peer.remoteId,
    ]);
  }
}

function chatSummary(chat: ChatInfo): { classification: Classification; reason: ClassificationReason } {
  return chat.kind === 'broadcast'
    ? { classification: 'automated', reason: 'broadcast' }
    : { classification: 'conversational', reason: 'chat-member' };
}

const DELETE_CHUNK = 100;

function deleteIn(db: IndexDatabase, sql: (placeholders: string) => string, ids: readonly string[]): void {
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_CHUNK);
    db.prepare(sql(placeholders(chunk.length))).run(...chunk);
  }
}

/**
 * A message already in the index: its row id, the network's sequence, and the network's own id —
 * the last because a probe asks the network in ITS terms, not the index's.
 */
interface StoredMessage {
  id: string;
  seq: number;
  remoteId: string;
}

/**
 * The stored messages of one account, by conversation — only loaded for a full scan, which is
 * the one run that can tell a deleted message from one that was never fetched.
 */
function loadStoredSeqs(db: IndexDatabase, backend: string, accountId: string): Map<string, StoredMessage[]> {
  const rows = db
    .prepare(
      `SELECT id, conversation_id, remote_id, ${seqColumn('remote_seq')} FROM conversation_messages
         WHERE backend = ? AND account_id = ? AND remote_seq IS NOT NULL`,
    )
    .all(backend, accountId) as Array<Record<string, unknown>>;
  const result = new Map<string, StoredMessage[]>();
  for (const r of rows) {
    const list = result.get(String(r.conversation_id)) ?? [];
    list.push({ id: String(r.id), seq: Number(r.remote_seq), remoteId: String(r.remote_id) });
    result.set(String(r.conversation_id), list);
  }
  return result;
}

/**
 * The next slice of a chat's deletion sweep: the oldest `depth` stored messages BELOW the window
 * the run re-read and above where the last sweep got (ADR 0004). A sweep that ran out of
 * candidates starts again at the chat's oldest message, in this very run — otherwise a run would
 * be spent on nothing but the reset.
 */
function probeSlice(
  stored: readonly StoredMessage[],
  below: number,
  after: number | null,
  depth: number,
): { slice: StoredMessage[]; from: number | null } {
  const candidates = [...stored].filter((m) => m.seq < below).sort((a, b) => a.seq - b.seq);
  const take = (from: number | null): StoredMessage[] =>
    candidates.filter((m) => from === null || m.seq > from).slice(0, depth);
  const slice = take(after);
  return slice.length > 0 || after === null ? { slice, from: after } : { slice: take(null), from: null };
}

/**
 * The stored messages a complete page proves deleted: inside the range the page covered —
 * from its lowest sequence (or the chat's start, when it reached it) up to its highest (or
 * everything, since the window is the newest and nothing newer exists) — but not in it.
 */
export function deletedBy(
  page: Pick<ChatHistoryPage, 'messages' | 'lowestSeq' | 'highestSeq' | 'exhausted' | 'reachedStart'>,
  stored: ReadonlyArray<{ id: string; seq: number }>,
): string[] {
  // An empty page that did not reach the start proves nothing.
  if (page.lowestSeq === null && !page.reachedStart) return [];
  const low = page.reachedStart ? Number.NEGATIVE_INFINITY : (page.lowestSeq ?? Number.NEGATIVE_INFINITY);
  const high = page.exhausted ? Number.POSITIVE_INFINITY : (page.highestSeq ?? Number.NEGATIVE_INFINITY);
  const live = new Set(page.messages.map((m) => m.seq));
  return stored.filter((m) => m.seq >= low && m.seq <= high && !live.has(m.seq)).map((m) => m.id);
}

export { LOCAL_ECHO_PREFIX } from './local-echo.ts';

function writeBatch(db: IndexDatabase, batch: ChatBatch): void {
  withTransaction(db, () => writeBatchRows(db, batch));
}

/** The batch's writes, without the transaction — for a caller that already opened one. */
function writeBatchRows(db: IndexDatabase, batch: ChatBatch): void {
  // The network's copy of a message curlew sent replaces the local echo written at send time.
  if (batch.clientIds.size > 0) {
    const echoes = db
      .prepare(
        `SELECT id, remote_id, body FROM conversation_messages
           WHERE backend = ? AND account_id = ? AND remote_id LIKE '${LOCAL_ECHO_PREFIX}%'`,
      )
      .all(batch.backend, batch.accountId) as Array<Record<string, unknown>>;
    if (echoes.length > 0) {
      const gone: string[] = [];
      for (const echo of echoes) {
        const remoteId = String(echo.remote_id);
        const row = batch.clientIds.get(remoteId.slice(LOCAL_ECHO_PREFIX.length));
        if (!remoteId.startsWith(LOCAL_ECHO_PREFIX) || row === undefined) continue;
        adoptEchoBody(row, echo.body);
        gone.push(String(echo.id));
      }
      deleteIn(db, (p) => `DELETE FROM conversation_messages WHERE id IN (${p})`, gone);
    }
  }
  // Deletions first: other people's words the server no longer has must not outlive it here.
  deleteIn(db, (p) => `DELETE FROM conversation_messages WHERE id IN (${p})`, batch.deletedMessages);
  for (const table of [
    'conversation_messages',
    'chat_members',
    'chat_cursors',
    'conversation_participants',
  ]) {
    deleteIn(db, (p) => `DELETE FROM ${table} WHERE conversation_id IN (${p})`, batch.deletedConversations);
  }
  deleteIn(db, (p) => `DELETE FROM conversations WHERE id IN (${p})`, batch.deletedConversations);

  // A replace resets the aggregates to their defaults; the UPDATE below recomputes them in
  // the same transaction.
  insertMany(
    db,
    `INSERT OR REPLACE INTO conversations
       (id, backend, account_id, kind, title, classification, classification_reason)`,
    batch.conversations,
  );
  // INSERT OR REPLACE: a re-fetched message (a full scan) replaces its row with the edited text.
  insertMany(
    db,
    `INSERT OR REPLACE INTO conversation_messages
       (id, conversation_id, backend, account_id, presentation, sender_name, sender_kind,
        sender_address, from_self, sent_at, has_attachments, classification, classification_reason,
        remote_id, body, remote_seq, sender_peer_id, edited_at, reply_to_remote_id, thread_remote_id, reply_to_client_id)`,
    batch.messages,
  );
  insertMany(
    db,
    'INSERT OR REPLACE INTO chat_peers (backend, account_id, peer_id, display_name, addresses_json, is_bot)',
    [...batch.peers.values()],
  );
  // REPLACE, not IGNORE, although the row is identical: libgda logs a warning for every
  // ignored insert, when it looks for the "last inserted row" that was never inserted.
  insertMany(db, 'INSERT OR REPLACE INTO chat_members (conversation_id, backend, account_id, peer_id)', [
    ...batch.members.values(),
  ]);
  insertMany(
    db,
    `INSERT OR REPLACE INTO chat_cursors
       (conversation_id, backend, account_id, chat_id, kind, last_seq, read_inbox_seq, read_outbox_seq, last_sync_at,
        last_cursor, probe_seq, room_public, room_encrypted, room_members)`,
    batch.cursors,
  );
  // After the inserts, so a correction or retraction of a message written in this very batch
  // lands on it. Both are rare (one statement per edit is fine for the execution budget).
  for (const edit of batch.edits) {
    // With a sender: the user's own message matches '', anyone else's its peer id.
    const bySender =
      edit.length > 4 ? ` AND ((from_self = 1 AND ? = '') OR (from_self = 0 AND sender_peer_id = ?))` : '';
    db.prepare(
      `UPDATE conversation_messages SET body = ?, edited_at = ? WHERE conversation_id = ? AND remote_id = ?${bySender}`,
    ).run(...edit);
  }
  deleteIn(db, (p) => `DELETE FROM conversation_messages WHERE id IN (${p})`, batch.retracted);
  // Read state and the conversation aggregates, set-based: two executions per account however
  // many chats changed. `seen` for the user's own messages is always 1; for the others it is
  // the network's read marker, which moves without any new message arriving. A notice is seen
  // too — nobody sent it, so no read marker will ever reach it and the chat would stay unread.
  db.prepare(
    `UPDATE conversation_messages SET
       seen = CASE WHEN from_self = 1 OR presentation = 'notice' THEN 1
                   WHEN remote_seq <= COALESCE((SELECT c.read_inbox_seq FROM chat_cursors c
                          WHERE c.conversation_id = conversation_messages.conversation_id), 0) THEN 1
                   ELSE 0 END,
       peer_read = CASE WHEN from_self = 1 AND remote_seq <= COALESCE((SELECT c.read_outbox_seq FROM chat_cursors c
                          WHERE c.conversation_id = conversation_messages.conversation_id), 0) THEN 1
                   ELSE 0 END
     WHERE backend = ? AND account_id = ? AND remote_seq IS NOT NULL`,
  ).run(batch.backend, batch.accountId);
  db.prepare(
    conversationTotalsSql(
      `backend = ? AND account_id = ?
       AND id IN (SELECT conversation_id FROM chat_cursors WHERE backend = ? AND account_id = ?)`,
    ),
  ).run(batch.backend, batch.accountId, batch.backend, batch.accountId);
  appendChanges(
    db,
    [...batch.changed].map((conversationId) => ({
      kind: 'messages' as const,
      backend: batch.backend,
      accountId: batch.accountId,
      conversationId,
    })),
  );
}

/** Where `body` sits in a {@link messageRow}. The INSERT's column list is the other half. */
const BODY_COLUMN = 14;

/**
 * Give the archive's copy of a message the text its local echo already had, when the archive's
 * copy has none.
 *
 * An encrypted message arrives from the archive as ciphertext this device may not be able to
 * read — a message sent before the current ratchet step is gone for good, and its prekey is
 * spent. The echo written at send time holds the plaintext (ADR 0006 §8), and it is about to be
 * deleted in favour of the archive row; without this the user's own words vanish from the index
 * the moment the server echoes them back.
 *
 * Only fills a hole, never overwrites: when the archive copy decrypted, that text is the one the
 * network actually carried, and an edit made elsewhere is in it.
 */
function adoptEchoBody(row: SqlValue[], body: unknown): void {
  if (row[BODY_COLUMN] !== null && row[BODY_COLUMN] !== undefined) return;
  if (typeof body === 'string' && body.length > 0) row[BODY_COLUMN] = body;
}

function messageRow(
  batch: ChatBatch,
  conversationId: string,
  chat: Pick<ChatInfo, 'kind'>,
  m: ChatMessage,
): SqlValue[] {
  const verdict = classifyChatMessage(chat, m);
  const sender = m.fromSelf ? null : m.sender;
  const address = sender?.addresses[0] ?? null;
  return [
    stableId('m-', conversationId, m.remoteId),
    conversationId,
    batch.backend,
    batch.accountId,
    // Chat stays chat in presentation (ADR 0001 §1) — except for what the backend put into the
    // stream itself rather than received, like an OMEMO identity-change notice (ADR 0006 §6).
    m.notice ? 'notice' : 'bubble',
    sender?.displayName ?? null,
    address?.kind ?? null,
    address?.value ?? null,
    m.fromSelf ? 1 : 0,
    m.sentAt,
    m.hasAttachments ? 1 : 0,
    verdict.classification,
    verdict.reason,
    m.remoteId,
    m.text,
    m.seq,
    sender?.remoteId ?? null,
    m.editedAt,
    m.replyToRemoteId,
    m.threadRemoteId,
    m.replyToClientId ?? null,
  ];
}

/**
 * Count one failed chat fetch, by category and never by text. A `ChatRateLimitedError` also
 * stamps the account's `rateLimited`, which is what stops the run for THIS account.
 */
function recordChatError(result: ChatAccountSyncResult, err: unknown): void {
  result.chatErrors++;
  if (isChatRateLimitedError(err)) {
    result.chatErrorKinds['rate-limited']++;
    result.rateLimited = { retryAfterMs: err.retryAfterMs };
  } else {
    result.chatErrorKinds.other++;
  }
}

async function syncAccount(
  db: IndexDatabase,
  backend: ChatBackend,
  account: { id: string; identity: string; provider: string; address?: string },
  options: Required<Omit<ChatSyncOptions, 'accountId' | 'lease'>>,
  budget: { total: number; remaining: number; exhausted: boolean },
): Promise<ChatAccountSyncResult> {
  const name = backend.manifest.name;
  const result: ChatAccountSyncResult = {
    backend: name,
    accountId: account.id,
    chats: 0,
    chatsFetched: 0,
    added: 0,
    removed: 0,
    chatErrors: 0,
    chatErrorKinds: { 'rate-limited': 0, other: 0 },
    rateLimited: null,
    error: null,
  };
  upsertAccount(db, account);

  let session: ChatSession;
  try {
    session = await backend.connect(account.id, {
      decrypt: true,
    });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }

  const batch = new ChatBatch(name, account.id);
  const syncedAt = options.now().toISOString();
  try {
    let chats: ChatInfo[];
    try {
      chats = await session.listChats();
    } catch (err) {
      // A rate limit while listing is the account being throttled before a single chat: report
      // it and leave — no error, so the account is not counted as failed.
      if (isChatRateLimitedError(err)) {
        result.rateLimited = { retryAfterMs: err.retryAfterMs };
        return result;
      }
      throw err;
    }
    result.chats = chats.length;
    const cursors = loadCursors(db, name, account.id);
    const stored = options.fullScan ? loadStoredSeqs(db, name, account.id) : null;
    if (options.fullScan) {
      // A chat that left the list (deleted, or the user left it) goes with its messages.
      const live = new Set(chats.map((c) => c.remoteId));
      for (const chatId of cursors.keys()) {
        if (live.has(chatId)) continue;
        const gone = chatConversationId(name, account.id, chatId);
        batch.deletedConversations.push(gone);
        batch.changed.add(gone);
      }
    }

    for (const chat of chats) {
      const conversationId = chatConversationId(name, account.id, chat.remoteId);
      const cursor = cursors.get(chat.remoteId);
      // A network that pages by archive id reports its newest id: caught up means we stored it.
      const caughtUp =
        cursor !== undefined &&
        (chat.lastCursor !== undefined
          ? chat.lastCursor === null || cursor.lastCursor === chat.lastCursor
          : chat.lastSeq === null || (cursor.lastSeq ?? -1) >= chat.lastSeq);
      let lastSeq = cursor?.lastSeq ?? null;
      let lastCursor = cursor?.lastCursor ?? null;
      const collect = (page: ChatHistoryPage): void => {
        for (const edit of page.edits ?? []) batch.edit(conversationId, edit);
        for (const remoteId of page.retracted ?? []) batch.retract(conversationId, remoteId);
        result.removed += page.retracted?.length ?? 0;
      };
      // A full scan re-takes the window only of a chat that is caught up; one with new messages
      // walks forward first, or everything between its cursor and the window would be skipped.
      const windowed = lastSeq === null || (options.fullScan && caughtUp);
      // A window is taken whole or not at all: a window cut short by the budget would never be
      // back-filled (later runs only walk forward). The first fetch of a run always goes ahead,
      // so a `historyDepth` above `maxMessages` still makes progress.
      const windowFits = budget.remaining >= options.historyDepth || budget.remaining === budget.total;
      if (windowed && !caughtUp && !windowFits) {
        budget.exhausted = true;
        // Never seen: leave it out entirely, so the next run starts it fresh.
        if (!cursor) continue;
      }

      const fetched: ChatMessage[] = [];
      let failed = false;
      let rateLimited = false;
      // The window's bottom: below it `deletedBy` proves nothing, so that is where the probe
      // starts. Null means there is nothing to probe — no window was re-read this run, or it
      // reached the chat's start and covered everything stored.
      let probeBelow: number | null = null;
      if ((!caughtUp || options.fullScan) && (!windowed || windowFits)) {
        try {
          if (windowed) {
            const limit = Math.min(options.historyDepth, Math.max(budget.remaining, 0));
            if (limit > 0) {
              const page = await session.fetchHistory(chat.remoteId, null, limit);
              fetched.push(...page.messages);
              collect(page);
              if (page.highestSeq !== null && page.highestSeq >= (lastSeq ?? -1)) {
                lastSeq = page.highestSeq;
                lastCursor = page.highestCursor ?? null;
              }
              if (stored && cursor) {
                const gone = deletedBy(page, stored.get(conversationId) ?? []);
                batch.deletedMessages.push(...gone);
                if (gone.length > 0) batch.changed.add(conversationId);
                result.removed += gone.length;
                if (!page.reachedStart && page.lowestSeq !== null) probeBelow = page.lowestSeq;
              }
            }
          } else {
            for (;;) {
              const limit = Math.min(options.pageSize, budget.remaining - fetched.length);
              if (limit <= 0) {
                budget.exhausted = true;
                break;
              }
              const page = await session.fetchHistory(chat.remoteId, lastSeq, limit, lastCursor);
              fetched.push(...page.messages.filter((m) => lastSeq === null || m.seq > lastSeq));
              collect(page);
              if (page.highestSeq !== null && page.highestSeq > (lastSeq ?? -1)) {
                lastSeq = page.highestSeq;
                lastCursor = page.highestCursor ?? null;
              } else break;
              if (page.exhausted) break;
            }
          }
        } catch (err) {
          // Keep what arrived and the cursor that covers it; the rest is retried next run. The
          // network's message is not recorded: it may quote the chat.
          recordChatError(result, err);
          failed = true;
          rateLimited = isChatRateLimitedError(err);
        }
        budget.remaining -= fetched.length;
        result.chatsFetched++;
      }
      // A first fetch that failed outright leaves no trace, so the next run starts it fresh.
      // A rate limit is the exception: there is no point trying the NEXT chat of this account.
      if (failed && !cursor && fetched.length === 0) {
        if (rateLimited) break;
        continue;
      }

      // Below the window `deletedBy` proves nothing, so a full scan asks the network about the
      // stored ids themselves — one bounded slice per run, advancing `probe_seq` so successive
      // scans walk the whole stored history (ADR 0004). Only for a network that can be asked, and
      // never after a rate limit: that is the one answer that says "stop asking".
      let probeSeq = cursor?.probeSeq ?? null;
      if (
        !rateLimited &&
        stored &&
        cursor &&
        probeBelow !== null &&
        session.probeRetracted &&
        options.probeDepth > 0
      ) {
        const candidates = stored.get(conversationId) ?? [];
        const { slice, from } = probeSlice(candidates, probeBelow, probeSeq, options.probeDepth);
        if (slice.length === 0) probeSeq = from;
        else {
          try {
            const asked = slice.map((m) => m.remoteId);
            const gone = new Set(await session.probeRetracted(chat.remoteId, asked));
            for (const m of slice) {
              if (!gone.has(m.remoteId)) continue;
              batch.deletedMessages.push(m.id);
              batch.changed.add(conversationId);
              result.removed++;
            }
            probeSeq = slice[slice.length - 1].seq;
          } catch (err) {
            // A probe that failed says nothing about the ids it was asked: nothing is removed and
            // the sweep stays where it was, so the next run asks this same slice again. The
            // network's message is not recorded: it may quote the chat.
            recordChatError(result, err);
            if (isChatRateLimitedError(err)) rateLimited = true;
          }
        }
      }

      const summary = chatSummary(chat);
      batch.conversations.push([
        conversationId,
        name,
        account.id,
        chat.kind === 'direct' ? 'direct' : 'group',
        chat.title,
        summary.classification,
        summary.reason,
      ]);
      for (const member of chat.members) batch.member(conversationId, member);
      for (const m of fetched) {
        if (!m.fromSelf && m.sender) batch.member(conversationId, m.sender);
        const row = messageRow(batch, conversationId, chat, m);
        batch.messages.push(row);
        if (m.clientId) batch.clientIds.set(m.clientId, row);
      }
      result.added += fetched.length;
      // New messages, a chat new to the index, or a moved read marker (the unread count follows).
      if (
        fetched.length > 0 ||
        !cursor ||
        cursor.readInboxSeq !== chat.readInboxSeq ||
        cursor.readOutboxSeq !== chat.readOutboxSeq
      ) {
        batch.changed.add(conversationId);
      }
      batch.cursors.push([
        conversationId,
        name,
        account.id,
        chat.remoteId,
        chat.kind,
        lastSeq,
        chat.readInboxSeq,
        chat.readOutboxSeq,
        syncedAt,
        lastCursor,
        probeSeq,
        flag(chat.room?.public),
        flag(chat.room?.encrypted),
        chat.room?.memberCount ?? null,
      ]);
      // The network asked this account to wait. What this chat already delivered is in the batch
      // and is committed by the `finally` below; the cursor covers exactly it, so a later run
      // carries on from here. No further chat of THIS account is asked — other accounts still run.
      if (rateLimited) break;
    }
    result.removed += batch.deletedConversations.length;

    // Late news about messages stored earlier (a decryption key that arrived only now), for
    // every chat — also the ones that had nothing new and were not fetched. Skipped after a rate
    // limit: `revisions()` is another question to the same network that just said "wait".
    if (result.rateLimited === null) {
      for (const revision of (await session.revisions?.()) ?? []) {
        const conversationId = chatConversationId(name, account.id, revision.chatRemoteId);
        if (!cursors.has(revision.chatRemoteId) && !chats.some((c) => c.remoteId === revision.chatRemoteId))
          continue;
        for (const remoteId of revision.retracted ?? []) batch.retract(conversationId, remoteId);
        result.removed += revision.retracted?.length ?? 0;
        for (const edit of revision.edits ?? []) batch.edit(conversationId, edit);
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    // Whatever was fetched before a failure is written: its cursors cover exactly it.
    writeBatch(db, batch);
    try {
      await session.close();
    } catch (err) {
      // Loud, not swallowed: closing is where a backend persists its own secret state (Matrix's
      // crypto store). What was written above stays; the account still reports the failure.
      const message = `closing the session failed: ${err instanceof Error ? err.message : String(err)}`;
      result.error = result.error ? `${result.error}; ${message}` : message;
    }
  }
  return result;
}

/**
 * One account behind the receive lease: taken and released like the delivery path does (there is
 * no read-only check, and a daemon starting mid-run must wait for this run, not race it).
 * A live foreign lease, or a busy index, ends the account here with nothing opened.
 */
async function syncUnderLease(
  db: IndexDatabase,
  backend: ChatBackend,
  account: { id: string; identity: string; provider: string; address?: string },
  options: Required<Omit<ChatSyncOptions, 'accountId' | 'lease'>>,
  budget: { total: number; remaining: number; exhausted: boolean },
  lease: NonNullable<ChatSyncOptions['lease']>,
): Promise<ChatAccountSyncResult> {
  const name = backend.manifest.name;
  const holder = lease.holder ?? String(process.pid);
  const interval = lease.intervalMs ?? LEASE_HEARTBEAT_MS;
  let take: LeaseTake;
  try {
    take = takeReceiveLease(db, name, account.id, holder, options.now(), interval);
  } catch {
    // The index was busy: not knowing who holds the account is the same as not holding it.
    take = { acquired: false, holder: null, heartbeatAt: null };
  }
  if (!take.acquired) {
    const standDown: ChatAccountSyncResult = {
      backend: name,
      accountId: account.id,
      chats: 0,
      chatsFetched: 0,
      added: 0,
      removed: 0,
      chatErrors: 0,
      chatErrorKinds: { 'rate-limited': 0, other: 0 },
      rateLimited: null,
      error: null,
    };
    if (take.holder === null) standDown.indexBusy = true;
    else standDown.heldBy = take.holder;
    return standDown;
  }
  const beat = setInterval(() => {
    try {
      refreshReceiveLease(db, name, account.id, holder, options.now(), interval);
    } catch {
      // A busy index misses one beat; the lease outlives several.
    }
  }, interval);
  try {
    return await syncAccount(db, backend, account, options, budget);
  } finally {
    clearInterval(beat);
    try {
      releaseReceiveLease(db, name, account.id, holder);
    } catch {
      // Left to expire.
    }
  }
}

/** Sync every account of one chat backend into the index. */
export async function syncChats(
  db: IndexDatabase,
  backend: ChatBackend,
  options: ChatSyncOptions = {},
): Promise<ChatSyncResult> {
  const resolved = {
    historyDepth: options.historyDepth ?? CHAT_HISTORY_DEPTH,
    maxMessages: options.maxMessages ?? CHAT_MAX_MESSAGES,
    pageSize: options.pageSize ?? DEFAULT_PAGE,
    fullScan: options.fullScan ?? false,
    probeDepth: options.probeDepth ?? CHAT_PROBE_DEPTH,
    now: options.now ?? (() => new Date()),
  };
  const budget = { total: resolved.maxMessages, remaining: resolved.maxMessages, exhausted: false };
  const accounts = (await backend.listAccounts()).filter(
    (a) => !options.accountId || a.id === options.accountId,
  );
  const results: ChatAccountSyncResult[] = [];
  for (const account of accounts) {
    results.push(
      options.lease
        ? await syncUnderLease(db, backend, account, resolved, budget, options.lease)
        : await syncAccount(db, backend, account, resolved, budget),
    );
  }
  const errors = results.filter((r) => r.error !== null).length;
  return {
    accounts: results,
    added: results.reduce((n, r) => n + r.added, 0),
    removed: results.reduce((n, r) => n + r.removed, 0),
    errors,
    failed: results.length > 0 && errors === results.length,
    budgetExhausted: budget.exhausted,
  };
}

export interface SentChatRecord {
  backend: string;
  account: { id: string; identity: string; provider: string; address?: string };
  /** The chat's remote id — for a direct XMPP chat, the peer's bare JID. */
  chatRemoteId: string;
  /** The id the message was sent with (XMPP origin-id): the network's own copy replaces this row. */
  clientId: string;
  text: string;
  /** ISO 8601, local clock. */
  sentAt: string;
}

/**
 * Store a message curlew itself just sent as the account's own message of a direct chat (ADR 0004
 * §5). Creates the conversation when the chat is new to the index. The row carries a local remote
 * id; the next sync that meets the network's copy (by `clientId`) deletes it, so nothing is
 * stored twice. Returns the conversation id and the row's id.
 */
export function recordSentChatMessage(
  db: IndexDatabase,
  record: SentChatRecord,
): { conversationId: string; messageId: string } {
  // One transaction around the lookup AND the write: the delivered copy may land between them
  // otherwise, and the echo written then is the duplicate this check exists to prevent.
  return withTransaction(db, () => recordSentRows(db, record));
}

function recordSentRows(
  db: IndexDatabase,
  record: SentChatRecord,
): { conversationId: string; messageId: string } {
  const { backend, account, chatRemoteId } = record;
  upsertAccount(db, account);
  const delivered = deliveredTwin(db, backend, account.id, record.clientId);
  if (delivered !== null) return adoptedByDelivered(db, record, delivered);
  const conversationId = chatConversationId(backend, account.id, chatRemoteId);
  const batch = new ChatBatch(backend, account.id);
  if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) {
    const summary = chatSummary({ kind: 'direct' } as ChatInfo);
    batch.conversations.push([
      conversationId,
      backend,
      account.id,
      'direct',
      chatRemoteId,
      summary.classification,
      summary.reason,
    ]);
    batch.member(conversationId, {
      remoteId: chatRemoteId,
      displayName: null,
      addresses: [{ kind: 'jid', value: chatRemoteId }],
      bot: false,
    });
  }
  if (!db.prepare('SELECT 1 FROM chat_cursors WHERE conversation_id = ?').get(conversationId)) {
    // No history cursor: the next sync takes this chat's window, like any chat never synced.
    batch.cursors.push([
      conversationId,
      backend,
      account.id,
      chatRemoteId,
      'direct',
      null,
      null,
      null,
      record.sentAt,
      null,
      null,
      null,
      null,
      null,
    ]);
  }
  const row = messageRow(
    batch,
    conversationId,
    { kind: 'direct' },
    {
      remoteId: `${LOCAL_ECHO_PREFIX}${record.clientId}`,
      seq: Date.parse(record.sentAt),
      sentAt: record.sentAt,
      editedAt: null,
      sender: null,
      fromSelf: true,
      text: record.text,
      hasAttachments: false,
      replyToRemoteId: null,
      threadRemoteId: null,
    },
  );
  batch.messages.push(row);
  batch.changed.add(conversationId);
  writeBatchRows(db, batch);
  return { conversationId, messageId: String(row[0]) };
}

interface DeliveredTwin {
  id: string;
  conversationId: string;
  body: unknown;
}

/**
 * The network's own copy of the message about to be recorded, when it is already in the index.
 *
 * With a daemon running, a send is routed THROUGH it (`sendSharesReceiveState`), and the
 * daemon's socket receives the message back — writing the delivered row — before the caller
 * returns from the send and records it. An echo written beside that row would never be adopted:
 * the adoption in {@link writeBatchRows} happens when the delivered copy ARRIVES, and it arrives
 * exactly once. The duplicate would stand in the chat forever, which is what it did.
 */
function deliveredTwin(
  db: IndexDatabase,
  backend: string,
  accountId: string,
  clientId: string,
): DeliveredTwin | null {
  const row = db
    .prepare(
      `SELECT id, conversation_id, body FROM conversation_messages
         WHERE backend = ? AND account_id = ? AND remote_id = ?`,
    )
    .get(backend, accountId, clientId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return { id: String(row.id), conversationId: String(row.conversation_id), body: row.body };
}

/**
 * Record the send as the delivered row that already holds it, giving that row the sent text
 * when it has none — the same hole-filling, never-overwriting rule as {@link adoptEchoBody},
 * for the order in which the echo is the one that comes second.
 */
function adoptedByDelivered(
  db: IndexDatabase,
  record: SentChatRecord,
  delivered: DeliveredTwin,
): { conversationId: string; messageId: string } {
  const empty = delivered.body === null || delivered.body === undefined || delivered.body === '';
  if (empty && record.text.length > 0) {
    db.prepare('UPDATE conversation_messages SET body = ? WHERE id = ?').run(record.text, delivered.id);
    appendChanges(db, [
      {
        kind: 'messages',
        backend: record.backend,
        accountId: record.account.id,
        conversationId: delivered.conversationId,
      },
    ]);
  }
  return { conversationId: delivered.conversationId, messageId: delivered.id };
}
