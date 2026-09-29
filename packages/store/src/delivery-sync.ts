/**
 * The delivery sync engine — the `delivery` driver's counterpart of `syncChats`.
 *
 * Model (delivery only, ADR 0001 §2): the network pushes every message once and forgets it as
 * soon as this device acknowledged it. There is no history to walk and nothing to re-fetch, so
 * what this engine writes is the ONLY copy — the rows it owns are `state` in the backup sense,
 * not `derived` like the rest of the index.
 *
 * Driven entirely through the `DeliveryBackend` port, so it runs on Node against a fake backend
 * and `:memory:`. It never names a network. The same function serves `postbote sync` (mode
 * `catch-up`: receive the backlog, then stop) and a later daemon (mode `follow`: keep going).
 *
 * The rows are the chat tables `syncChats` writes (`conversation_messages`, `chat_peers`,
 * `chat_members`, `chat_cursors`), so conversations, participants, the address-book link and
 * every read path treat a delivered chat exactly like an archived one. `last_seq` in the cursor
 * is the newest message's sequence; the read markers stay null — read state arrives as events.
 *
 * Every batch is written in ONE transaction before the next one is asked for: the server has
 * already forgotten those messages. Executions are a per-process budget (gjsify gap, unfixed,
 * gjsify#1838 — see `insertMany`), so a batch costs a fixed handful of statements plus its
 * multi-row inserts, never one statement per message. Edits of stored messages are the one
 * per-item statement: they are rare.
 */

import type {
  ChatMessage,
  ChatPeer,
  DeliveryBackend,
  DeliveryChat,
  DeliveryEvent,
  DeliveryMode,
  DeliveryOutcome,
  DeliverySession,
  ParticipantAddress,
} from '@postbote/protocol';
import { chatConversationId, classifyChatMessage } from './chat-sync.ts';
import type { IndexDatabase } from './db.ts';
import { insertMany, placeholders, type SqlValue, withTransaction } from './db.ts';
import { upsertAccount } from './index-store.ts';
import {
  LEASE_HEARTBEAT_MS,
  type LeaseTake,
  refreshReceiveLease,
  releaseReceiveLease,
  takeReceiveLease,
} from './receive-lease.ts';
import { stableId } from './threads.ts';

export interface DeliverySyncOptions {
  /** Restrict to one account; omit for all. */
  accountId?: string;
  /** `catch-up` (the default) stops once the backlog is in; `follow` runs until the session closes. */
  mode?: DeliveryMode;
  /**
   * Stop the run. Each account's session is closed, so `nextBatch()` resolves `null` and its loop
   * ends **normally** — what was written stays written, and a stopped daemon is not an error.
   */
  signal?: AbortSignal;
  /**
   * Who holds the receive lease in `follow` mode (ADR 0002 §4) — the pid by default. Two delivery
   * devices on one account each acknowledge half the messages, so this is the lock between a
   * daemon and a `sync`; it is a lease, so a crashed holder expires without a cleanup.
   */
  holder?: string;
  /** How often the lease is refreshed. Short only in tests. */
  leaseIntervalMs?: number;
  /** Clock, injected so tests are deterministic. */
  now?: () => Date;
  /** How long to wait before a reconnect, injected so a backoff costs no wall clock in a test. */
  sleep?: (ms: number) => Promise<void>;
  /** Every state change, for a log line. Never carries content — only names, counts and timings. */
  onProgress?: (event: DeliveryProgress) => void;
}

/**
 * One state change of a follow-mode account, for a caller that logs. Never message text, chat
 * titles, peer names or numbers: the index holds other people's words and a log line is a file
 * that gets copied around (ADR 0002 §6).
 */
export type DeliveryProgress =
  | { backend: string; accountId: string; type: 'connected' }
  | {
      backend: string;
      accountId: string;
      type: 'batch';
      /** Batches written so far, and what the last one changed. */
      batches: number;
      added: number;
      edited: number;
      removed: number;
    }
  /**
   * A session ended and will be retried. `reason` is the failure's name and code — never its
   * message, which a network library may have filled with a JID or a number — or null when the
   * session ended without one.
   */
  | {
      backend: string;
      accountId: string;
      type: 'reconnect';
      delayMs: number;
      attempt: number;
      reason: string | null;
    }
  | { backend: string; accountId: string; type: 'logged-out'; error: string | null }
  /** A bounded run left the account to the holder and will not receive it. */
  | { backend: string; accountId: string; type: 'lease-held'; holder: string }
  /** The index was busy, so no lease could be taken and no holder is known. */
  | { backend: string; accountId: string; type: 'lease-busy' }
  /** A follow run is waiting its turn for the account; `holder` is null when nobody is known. */
  | { backend: string; accountId: string; type: 'lease-waiting'; holder: string | null }
  | { backend: string; accountId: string; type: 'lease-lost' }
  /**
   * The lease could not be refreshed twice in a row (the index was busy), so the account stopped
   * before its lease could look stale — and takes it again through the wait-for-lease path.
   */
  | { backend: string; accountId: string; type: 'lease-unrefreshable' }
  | { backend: string; accountId: string; type: 'stopped'; reason: 'aborted' | 'logged-out' };

/** The first wait after a dropped session, and its ceiling. Both are the daemon's, not the port's. */
export const RECONNECT_FIRST_MS = 5_000;
export const RECONNECT_CAP_MS = 5 * 60_000;

export interface DeliveryAccountSyncResult {
  backend: string;
  accountId: string;
  /** Batches received and written. */
  batches: number;
  /** Messages written. */
  added: number;
  /** Stored messages whose text changed. */
  edited: number;
  /** Messages and chats deleted on the network (or on the user's other device) and removed here. */
  removed: number;
  /** True when the session saw the backlog end; false when it stopped waiting for it. */
  caughtUp: boolean;
  /** An error that stopped the account (connect, a dropped session, a failed write). */
  error: string | null;
  /**
   * The network no longer knows this device (logged out, unlinked) — terminal, so a follow-mode
   * caller stops the account rather than reconnecting (`DeliveryOutcome.loggedOut`).
   */
  loggedOut?: boolean;
  /**
   * The account is being received by another holder (a running daemon, on `sync`): this run left
   * it alone, and that is a success — nothing failed, the messages are arriving. A real holder
   * only: "the index is busy" is `indexBusy` below, never a made-up name.
   */
  heldBy?: string;
  /**
   * The lease could not be taken because the index was busy (another writer mid-transaction). The
   * account was NOT received, and nobody is known to be receiving it either — its own state, not
   * a holder.
   */
  indexBusy?: true;
  /** Received but not mapped; kept raw by the backend for a later version (`DeliveryOutcome.setAside`). */
  setAside?: number;
  /** Received but not decryptable (`DeliveryOutcome.undecryptable`). */
  undecryptable?: number;
}

export interface DeliverySyncResult {
  accounts: DeliveryAccountSyncResult[];
  added: number;
  removed: number;
  errors: number;
  /** True when EVERY account failed — the only case that is an error overall. */
  failed: boolean;
}

interface KnownChat {
  kind: DeliveryChat['kind'];
  title: string | null;
  lastSeq: number | null;
}

interface KnownPeer {
  displayName: string | null;
  addresses: ParticipantAddress[];
  bot: boolean;
}

/** The account's chats and peers as stored — loaded once per account, kept current in memory. */
interface AccountState {
  chats: Map<string, KnownChat>;
  peers: Map<string, KnownPeer>;
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseAddresses(json: unknown): ParticipantAddress[] {
  try {
    const parsed = JSON.parse(String(json ?? '[]')) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (a): a is ParticipantAddress => typeof a?.kind === 'string' && typeof a?.value === 'string',
        )
      : [];
  } catch {
    // Written with JSON.stringify by this engine or `syncChats`; a damaged row starts empty.
    return [];
  }
}

function loadState(db: IndexDatabase, backend: string, accountId: string): AccountState {
  const chatRows = db
    .prepare(
      `SELECT c.chat_id, c.kind, c.last_seq, v.title FROM chat_cursors c
         LEFT JOIN conversations v ON v.id = c.conversation_id
        WHERE c.backend = ? AND c.account_id = ?`,
    )
    .all(backend, accountId) as Array<Record<string, unknown>>;
  const peerRows = db
    .prepare(
      'SELECT peer_id, display_name, addresses_json, is_bot FROM chat_peers WHERE backend = ? AND account_id = ?',
    )
    .all(backend, accountId) as Array<Record<string, unknown>>;
  return {
    chats: new Map(
      chatRows.map((r) => [
        String(r.chat_id),
        { kind: String(r.kind) as KnownChat['kind'], title: str(r.title), lastSeq: num(r.last_seq) },
      ]),
    ),
    peers: new Map(
      peerRows.map((r) => [
        String(r.peer_id),
        {
          displayName: str(r.display_name),
          addresses: parseAddresses(r.addresses_json),
          bot: Number(r.is_bot) === 1,
        },
      ]),
    ),
  };
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

interface PendingMessage {
  chatRemoteId: string;
  chatKind: DeliveryChat['kind'];
  message: ChatMessage;
  seen: boolean;
  peerRead: boolean;
}

/** One batch folded into the statements it needs, in event order. */
class DeliveryBatch {
  readonly messages = new Map<string, PendingMessage>();
  readonly deletedMessages = new Set<string>();
  readonly deletedChats = new Set<string>();
  readonly clearedChats = new Set<string>();
  readonly edits = new Map<
    string,
    { text: string | null; editedAt: string | null; conversationId: string }
  >();
  readonly peerRead = new Set<string>();
  /**
   * Messages read that no chat was named for — a Signal receipt carries sent timestamps only
   * (`refs/signal-desktop/protos/SignalService.proto:451`), so the remote ids are what locate
   * them. Kept apart from `peerRead` because their row ids are not known until the write.
   */
  readonly peerReadByRemoteId = new Set<string>();
  readonly chatRead = new Map<string, number>();
  readonly touchedChats = new Set<string>();
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
        if (!this.messages.has(id)) this.added++;
        this.messages.set(id, {
          chatRemoteId,
          chatKind: known.kind,
          message,
          seen: message.fromSelf || event.seen,
          peerRead: false,
        });
        return;
      }
      case 'edit': {
        const id = this.rowId(event.chatRemoteId, event.remoteId);
        const pending = this.messages.get(id);
        if (pending) {
          pending.message = { ...pending.message, text: event.text, editedAt: event.editedAt };
        } else if (!this.deletedMessages.has(id)) {
          this.edits.set(id, {
            text: event.text,
            editedAt: event.editedAt,
            conversationId: this.conversationId(event.chatRemoteId),
          });
          this.touchedChats.add(event.chatRemoteId);
        }
        this.edited++;
        return;
      }
      case 'delete': {
        const id = this.rowId(event.chatRemoteId, event.remoteId);
        if (this.messages.delete(id)) this.added--;
        this.edits.delete(id);
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

const IN_CHUNK = 100;

function runIn(
  db: IndexDatabase,
  sql: (placeholders: string) => string,
  ids: readonly string[],
  ...lead: SqlValue[]
): void {
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    db.prepare(sql(placeholders(chunk.length))).run(...lead, ...chunk);
  }
}

function messageRow(batch: DeliveryBatch, id: string, pending: PendingMessage): SqlValue[] {
  const { message: m } = pending;
  const verdict = classifyChatMessage({ kind: pending.chatKind }, m);
  const sender = m.fromSelf ? null : m.sender;
  const address = sender?.addresses[0] ?? null;
  return [
    id,
    chatConversationId(batch.backend, batch.accountId, pending.chatRemoteId),
    batch.backend,
    batch.accountId,
    m.notice ? 'notice' : 'bubble',
    sender?.displayName ?? null,
    address?.kind ?? null,
    address?.value ?? null,
    m.fromSelf ? 1 : 0,
    m.sentAt,
    pending.seen || m.notice ? 1 : 0,
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
    pending.peerRead ? 1 : 0,
  ];
}

/** The message columns, in `messageRow` order — also what a chat merge reads back. */
const MESSAGE_COLUMNS = `id, conversation_id, backend, account_id, presentation, sender_name, sender_kind,
  sender_address, from_self, sent_at, seen, has_attachments, classification, classification_reason,
  remote_id, body, remote_seq, sender_peer_id, edited_at, reply_to_remote_id, thread_remote_id, peer_read`;

/**
 * Move a chat stored under `from` into `into` — one chat the network addressed two ways (a
 * WhatsApp person by phone number first, by LID once the pair was known). Messages are re-keyed
 * (a row id includes its conversation) and re-inserted in multi-row statements; members follow;
 * the `from` conversation, its cursor and participants go. A handful of statements whatever the
 * chat's size, and nothing at all for a `from` that was never stored — the common case.
 */
function mergeChat(db: IndexDatabase, batch: DeliveryBatch, from: string, into: string): boolean {
  const { backend, accountId, state } = batch;
  const source = state.chats.get(from);
  if (!source || from === into) return false;
  const conv = (chatRemoteId: string) => chatConversationId(backend, accountId, chatRemoteId);
  const rows = db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM conversation_messages WHERE conversation_id = ?`)
    .all(conv(from)) as Array<Record<string, unknown>>;
  const columns = MESSAGE_COLUMNS.split(',').map((c) => c.trim());
  insertMany(
    db,
    `INSERT OR REPLACE INTO conversation_messages (${MESSAGE_COLUMNS})`,
    rows.map((r) =>
      columns.map((c): SqlValue => {
        if (c === 'id') return deliveredMessageId(backend, accountId, into, String(r.remote_id));
        if (c === 'conversation_id') return conv(into);
        const v = r[c];
        return v === undefined ? null : (v as SqlValue);
      }),
    ),
  );
  db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(conv(from));
  db.prepare(
    `INSERT OR REPLACE INTO chat_members (conversation_id, backend, account_id, peer_id)
       SELECT ?, backend, account_id, peer_id FROM chat_members WHERE conversation_id = ?`,
  ).run(conv(into), conv(from));
  for (const table of ['chat_members', 'chat_cursors', 'conversation_participants']) {
    db.prepare(`DELETE FROM ${table} WHERE conversation_id = ?`).run(conv(from));
  }
  db.prepare('DELETE FROM conversations WHERE id = ?').run(conv(from));
  const target = state.chats.get(into);
  const seqs = [target?.lastSeq, source.lastSeq].filter((n): n is number => typeof n === 'number');
  state.chats.set(into, {
    kind: target?.kind ?? source.kind,
    title: target?.title ?? source.title,
    lastSeq: seqs.length > 0 ? Math.max(...seqs) : null,
  });
  state.chats.delete(from);
  // The target's row, cursor and aggregates are written by the batch this merge belongs to.
  batch.touchedChats.add(into);
  return true;
}

/** Write one batch's rows. Runs inside the caller's transaction. */
function writeBatchRows(db: IndexDatabase, batch: DeliveryBatch, syncedAt: string): void {
  const { backend, accountId, state } = batch;
  const conv = (chatRemoteId: string) => chatConversationId(backend, accountId, chatRemoteId);
  {
    // Deletions first: words the user or the sender took back must not outlive that here.
    runIn(db, (p) => `DELETE FROM conversation_messages WHERE id IN (${p})`, [...batch.deletedMessages]);
    const cleared = [...batch.clearedChats, ...batch.deletedChats].map(conv);
    runIn(db, (p) => `DELETE FROM conversation_messages WHERE conversation_id IN (${p})`, cleared);
    const gone = [...batch.deletedChats].map(conv);
    for (const table of ['chat_members', 'chat_cursors', 'conversation_participants', 'conversations']) {
      const column = table === 'conversations' ? 'id' : 'conversation_id';
      runIn(db, (p) => `DELETE FROM ${table} WHERE ${column} IN (${p})`, gone);
    }

    const touched = [...batch.touchedChats].filter((id) => state.chats.has(id));
    // A replace resets the aggregates; the UPDATE below recomputes them in this transaction.
    insertMany(
      db,
      `INSERT OR REPLACE INTO conversations
         (id, backend, account_id, kind, title, classification, classification_reason)`,
      touched.map((id) => {
        const chat = state.chats.get(id) as KnownChat;
        const broadcast = chat.kind === 'broadcast';
        return [
          conv(id),
          backend,
          accountId,
          chat.kind === 'direct' ? 'direct' : 'group',
          chat.title,
          broadcast ? 'automated' : 'conversational',
          broadcast ? 'broadcast' : 'chat-member',
        ];
      }),
    );
    insertMany(
      db,
      `INSERT OR REPLACE INTO conversation_messages
         (id, conversation_id, backend, account_id, presentation, sender_name, sender_kind,
          sender_address, from_self, sent_at, seen, has_attachments, classification, classification_reason,
          remote_id, body, remote_seq, sender_peer_id, edited_at, reply_to_remote_id, thread_remote_id, peer_read)`,
      [...batch.messages].map(([id, pending]) => messageRow(batch, id, pending)),
    );
    for (const [id, edit] of batch.edits) {
      db.prepare('UPDATE conversation_messages SET body = ?, edited_at = ? WHERE id = ?').run(
        edit.text,
        edit.editedAt,
        id,
      );
    }
    runIn(db, (p) => `UPDATE conversation_messages SET peer_read = 1 WHERE from_self = 1 AND id IN (${p})`, [
      ...batch.peerRead,
    ]);
    // A receipt that named no chat: its remote ids find the rows, wherever they are stored. Only
    // the user's own messages qualify — a receipt is about what the user sent.
    runIn(
      db,
      (p) => `UPDATE conversation_messages SET peer_read = 1
                WHERE from_self = 1 AND backend = ? AND account_id = ? AND remote_id IN (${p})`,
      [...batch.peerReadByRemoteId],
      backend,
      accountId,
    );
    // Read on another device: everything but the newest `unread` incoming messages is read.
    for (const [chatRemoteId, unread] of batch.chatRead) {
      const id = conv(chatRemoteId);
      db.prepare(
        `UPDATE conversation_messages SET seen = CASE
           WHEN from_self = 1 THEN 1
           WHEN id IN (SELECT id FROM conversation_messages WHERE conversation_id = ? AND from_self = 0
                        ORDER BY remote_seq DESC, sent_at DESC LIMIT ?) THEN 0
           ELSE 1 END
         WHERE conversation_id = ?`,
      ).run(id, unread, id);
    }

    insertMany(
      db,
      'INSERT OR REPLACE INTO chat_peers (backend, account_id, peer_id, display_name, addresses_json, is_bot)',
      [...batch.touchedPeers].map((peerId) => {
        const peer = state.peers.get(peerId) as KnownPeer;
        return [
          backend,
          accountId,
          peerId,
          peer.displayName,
          JSON.stringify(peer.addresses),
          peer.bot ? 1 : 0,
        ];
      }),
    );
    // REPLACE, not IGNORE: libgda warns for every ignored insert (see chat-sync.ts).
    insertMany(db, 'INSERT OR REPLACE INTO chat_members (conversation_id, backend, account_id, peer_id)', [
      ...batch.members.values(),
    ]);
    insertMany(
      db,
      `INSERT OR REPLACE INTO chat_cursors
         (conversation_id, backend, account_id, chat_id, kind, last_seq, read_inbox_seq, read_outbox_seq, last_sync_at)`,
      touched.map((id) => {
        const chat = state.chats.get(id) as KnownChat;
        return [conv(id), backend, accountId, id, chat.kind, chat.lastSeq, null, null, syncedAt];
      }),
    );
    runIn(
      db,
      (p) => `UPDATE conversations SET
         message_count = (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = conversations.id),
         unread_count = (SELECT COUNT(*) FROM conversation_messages m
                          WHERE m.conversation_id = conversations.id AND m.from_self = 0 AND m.seen = 0),
         first_message_at = (SELECT MIN(sent_at) FROM conversation_messages m WHERE m.conversation_id = conversations.id),
         last_message_at = (SELECT MAX(sent_at) FROM conversation_messages m WHERE m.conversation_id = conversations.id),
         has_attachments = (SELECT COUNT(*) > 0 FROM conversation_messages m
                             WHERE m.conversation_id = conversations.id AND m.has_attachments = 1)
       WHERE id IN (${p})`,
      touched.map(conv),
    );
  }
}

/**
 * Write one batch of events in ONE transaction. A `chat-merged` whose source chat is stored
 * splits the batch: what came before it is written first, then the merge, then the rest — so
 * every event sees the chats exactly as the ones before it left them, without re-keying events
 * in memory. A merge of a chat never stored does not split anything.
 */
function writeEvents(
  db: IndexDatabase,
  backend: string,
  accountId: string,
  state: AccountState,
  events: readonly DeliveryEvent[],
  syncedAt: string,
): { added: number; edited: number; removed: number } {
  const totals = { added: 0, edited: 0, removed: 0 };
  withTransaction(db, () => {
    let batch = new DeliveryBatch(backend, accountId, state);
    const flush = () => {
      writeBatchRows(db, batch, syncedAt);
      totals.added += batch.added;
      totals.edited += batch.edited;
      totals.removed += batch.removed;
      batch = new DeliveryBatch(backend, accountId, state);
    };
    for (const event of events) {
      if (event.type === 'chat-merged') {
        if (!state.chats.has(event.from) || event.from === event.into) continue;
        flush();
        mergeChat(db, batch, event.from, event.into);
        continue;
      }
      batch.apply(event);
    }
    flush();
  });
  return totals;
}

/** The default wait, interruptible: a daemon that is asked to stop does not sit out its backoff. */
function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done);
  });
}

/** What `raceAbort` resolves with when the run was stopped before the work finished. */
const ABORTED = Symbol('aborted');

/**
 * A failure in a form that can be logged: the error's NAME and CODE, never its message.
 *
 * Chosen deliberately. Baileys and libsignal put network detail in the message, and a network
 * error can name what it was talking to — a JID, a phone number, a display name — and the log
 * line is a file that gets copied and pasted around (ADR 0002 §6). The name and the code are
 * structural: `Error`, `SqliteError`, `ECONNRESET`, HTTP 401.
 */
function shortReason(err: unknown): string {
  if (!(err instanceof Error)) return 'Error';
  const code = (err as { code?: unknown }).code;
  const status = (err as { output?: { statusCode?: unknown } }).output?.statusCode;
  const parts = [err.name];
  if (typeof code === 'number' || typeof code === 'string') parts.push(String(code));
  if (typeof status === 'number') parts.push(String(status));
  return parts.join('/');
}

/**
 * `work`, or `ABORTED` the moment the run is stopped.
 *
 * Needed wherever a promise can be pending while the run is asked to end — the listener is
 * attached once, and an `addEventListener` on an ALREADY aborted signal never fires, so a plain
 * `await work` behind a later `addEventListener` is a hang waiting for a network timeout.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** One session of one account, from connect to close. Reports into `result` as it goes. */
async function runSession(
  db: IndexDatabase,
  backend: DeliveryBackend,
  account: { id: string; identity: string; provider: string },
  mode: DeliveryMode,
  now: () => Date,
  signal: AbortSignal | undefined,
  onProgress: ((event: DeliveryProgress) => void) | undefined,
  result: DeliveryAccountSyncResult,
  /** Why the last session ended, in a form that can be logged. Read after the call. */
  note: { reason: string | null },
): Promise<DeliveryOutcome> {
  const name = backend.manifest.name;
  // The connect is the one step that can be pending for a LONG time — a network that is down
  // waits out its own timeouts — so it is raced against the stop, and a session that arrives
  // afterwards is closed at once: nobody is left to read it, and an open session acknowledges.
  const connecting = backend.connect(account.id, { mode });
  let session: DeliverySession;
  try {
    const raced = await raceAbort(connecting, signal);
    if (raced === ABORTED) {
      void connecting.then((late) => late.close()).catch(() => undefined);
      return { caughtUp: false, error: null, loggedOut: false };
    }
    session = raced;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // A connect that failed has no session and no progress event of its own, so the reason is
    // remembered for the reconnect line: "reconnect in 5000 ms" on its own says nothing.
    note.reason = shortReason(err);
    result.error = error;
    return { caughtUp: false, error, loggedOut: false };
  }
  // The abort can land in the same tick the connect resolved; a listener added now would never
  // fire, so the state is checked instead of only subscribed to.
  if (signal?.aborted) {
    await session.close().catch(() => undefined);
    return { caughtUp: false, error: null, loggedOut: false };
  }
  onProgress?.({ backend: name, accountId: account.id, type: 'connected' });

  const state = loadState(db, name, account.id);
  // An abort closes the session: `nextBatch()` then resolves null and the loop ends normally,
  // with whatever Baileys (or libsignal) still hands over on the way out written first. That
  // close is kept so the `finally` below awaits it instead of closing a second time.
  let closing: Promise<void> | null = null;
  const onAbort = () => {
    closing ??= session.close().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort);
  try {
    for (;;) {
      const events = await session.nextBatch();
      if (events === null) break;
      if (events.length === 0) continue;
      // A failed write stops the account: asking for more would acknowledge messages that
      // then exist nowhere (and the session keeps the batch in its journal for the next run).
      const written = writeEvents(db, name, account.id, state, events, now().toISOString());
      result.batches++;
      result.added += written.added;
      result.edited += written.edited;
      result.removed += written.removed;
      onProgress?.({
        backend: name,
        accountId: account.id,
        type: 'batch',
        batches: result.batches,
        added: written.added,
        edited: written.edited,
        removed: written.removed,
      });
    }
    const outcome = session.outcome();
    result.caughtUp = outcome.caughtUp;
    result.error = outcome.error;
    if (outcome.loggedOut) result.loggedOut = true;
    if (outcome.setAside) result.setAside = outcome.setAside;
    if (outcome.undecryptable) result.undecryptable = outcome.undecryptable;
    return outcome;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return { caughtUp: false, error: result.error, loggedOut: false };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (closing) {
      // Already closing because the run was stopped: await that, do not close again.
      await closing;
    } else {
      try {
        await session.close();
      } catch {
        // A failed goodbye does not undo what was written.
      }
    }
  }
}

/**
 * Receive for one account until the run is over: a `catch-up` session ends on its own, a
 * `follow` one reconnects (with backoff) until the signal says stop or the device is gone.
 */
async function receiveAccount(
  db: IndexDatabase,
  backend: DeliveryBackend,
  account: { id: string; identity: string; provider: string },
  options: DeliverySyncOptions,
): Promise<DeliveryAccountSyncResult> {
  const mode = options.mode ?? 'catch-up';
  const now = options.now ?? (() => new Date());
  const onProgress = options.onProgress;
  const name = backend.manifest.name;
  const result: DeliveryAccountSyncResult = {
    backend: name,
    accountId: account.id,
    batches: 0,
    added: 0,
    edited: 0,
    removed: 0,
    caughtUp: false,
    error: null,
  };
  // Stopped before this account even started: no lease, no connect, no write. (A listener added
  // to an already aborted signal never fires, so the state has to be read.)
  if (options.signal?.aborted) return result;
  try {
    upsertAccount(db, account);
  } catch (err) {
    // Bookkeeping, not delivery: this account is reported and skipped, and the run carries on.
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }

  // This account's own stop signal: the run's abort, plus a lost lease and a wait that is over.
  // Per account, so one stolen lease stops one account and not the daemon. Re-made for each
  // cycle, because a cycle that ends on a lease problem goes round again.
  let stop = new AbortController();
  const onRunAbort = () => stop.abort();
  options.signal?.addEventListener('abort', onRunAbort);

  // The lease (ADR 0002 §4), and BOTH modes take it before their first connect. One side taking
  // it is not a lock: a `sync` in the middle of a WhatsApp catch-up (up to ten minutes) would
  // still let a daemon connect to the same account, and two devices on one account each
  // acknowledge half the copy.
  const holder = options.holder ?? String(process.pid);
  const interval = options.leaseIntervalMs ?? LEASE_HEARTBEAT_MS;
  let wait = RECONNECT_FIRST_MS;
  let attempt = 0;
  const stopped = (reason: 'aborted' | 'logged-out') => {
    onProgress?.({ backend: name, accountId: account.id, type: 'stopped', reason });
    return result;
  };

  // One lease-and-sessions cycle. Several of them, because a cycle that has to give its lease up
  // goes back to the top and takes it again rather than leaving the account unreceived.
  for (;;) {
    let waitingFor: string | null = null;
    let leaseHeld = false;
    for (;;) {
      let take: LeaseTake;
      try {
        take = takeReceiveLease(db, name, account.id, holder, now(), interval);
      } catch {
        // The index was busy — another writer was mid-transaction. Not knowing who holds the
        // account is the same as not holding it, so wait rather than connect blind.
        take = { acquired: false, holder: null, heartbeatAt: null };
      }
      if (take.acquired) {
        leaseHeld = true;
        break;
      }
      if (mode !== 'follow') {
        // A bounded run does not wait: it reports the holder and leaves the account to it. Not an
        // error — those messages ARE arriving, and a run that red-flagged a working daemon would
        // teach the user to ignore red flags.
        if (take.holder === null) {
          // The index was busy, not held: "received by the running daemon" would be a lie about
          // a process that does not exist.
          result.indexBusy = true;
          onProgress?.({ backend: name, accountId: account.id, type: 'lease-busy' });
        } else {
          result.heldBy = take.holder;
          onProgress?.({
            backend: name,
            accountId: account.id,
            type: 'lease-held',
            holder: take.holder,
          });
        }
        options.signal?.removeEventListener('abort', onRunAbort);
        return result;
      }
      // A daemon waits for the lease and keeps taking it until it gets it: giving the account up
      // for good would mean never receiving it again. Logged once per holder, not once per try.
      if (take.holder !== waitingFor) {
        waitingFor = take.holder;
        onProgress?.({
          backend: name,
          accountId: account.id,
          type: 'lease-waiting',
          holder: take.holder,
        });
      }
      await abortableSleep(interval, stop.signal);
      if (stop.signal.aborted) {
        options.signal?.removeEventListener('abort', onRunAbort);
        return stopped('aborted');
      }
    }

    // Refreshed while receiving: a run that stops refreshing is a crashed run, and a `sync` or a
    // second daemon may take the account over. A `false` says somebody else is on this account
    // NOW — two receivers split the copy, so this one stops. A THROW says the index was busy,
    // which is not the same thing: nobody necessarily holds the lease, so the next tick tries
    // again. Two busy ticks in a row are not a hiccup either — the account stops before its lease
    // can look stale (three intervals), and the cycle below takes it back.
    let leaseLost = false;
    let busyTicks = 0;
    const heartbeat = setInterval(() => {
      let refreshed: boolean;
      try {
        refreshed = refreshReceiveLease(db, name, account.id, holder, now());
      } catch {
        busyTicks++;
        if (busyTicks < 2) return;
        onProgress?.({ backend: name, accountId: account.id, type: 'lease-unrefreshable' });
        stop.abort();
        return;
      }
      busyTicks = 0;
      if (refreshed) return;
      leaseLost = true;
      onProgress?.({ backend: name, accountId: account.id, type: 'lease-lost' });
      stop.abort();
    }, interval);

    let retake = false;
    const note: { reason: string | null } = { reason: null };
    try {
      for (;;) {
        const openedAt = now().getTime();
        attempt++;
        const outcome = await runSession(
          db,
          backend,
          account,
          mode,
          now,
          stop.signal,
          onProgress,
          result,
          note,
        );
        if (mode !== 'follow') return result;
        if (stop.signal.aborted) {
          // Stopped by the heartbeat over a lease it could not refresh: go round again, unless the
          // RUN was stopped, which no retry can undo.
          retake = busyTicks >= 2 && !options.signal?.aborted;
          break;
        }
        // The network dropped the device (logged out, unlinked): the credentials are gone, and
        // every reconnect would fail the same way — the run says so and stops this account.
        if (outcome.loggedOut) {
          onProgress?.({
            backend: name,
            accountId: account.id,
            type: 'logged-out',
            error: outcome.error,
          });
          return stopped('logged-out');
        }
        // A session that outlived the cap is a healthy network: the next drop starts at the
        // beginning again instead of inheriting a backoff from a bad hour.
        if (now().getTime() - openedAt >= RECONNECT_CAP_MS) wait = RECONNECT_FIRST_MS;
        onProgress?.({
          backend: name,
          accountId: account.id,
          type: 'reconnect',
          delayMs: wait,
          attempt,
          reason: note.reason,
        });
        // The wait is interruptible by default: a daemon that is asked to stop does not sit out a
        // backoff first. An injected `sleep` is the test's own, and answers at once.
        const sleep = options.sleep ?? ((ms: number) => abortableSleep(ms, stop.signal));
        await sleep(wait);
        if (stop.signal.aborted) break;
        wait = Math.min(wait * 2, RECONNECT_CAP_MS);
      }
    } finally {
      clearInterval(heartbeat);
      if (leaseHeld) {
        // Nothing in a `finally` may reject: the other accounts' loops are still writing, and a
        // rejection here would take the whole run down under them. A lease we cannot drop expires
        // by itself, so leaving it is a "left behind", not a failure.
        try {
          releaseReceiveLease(db, name, account.id, holder);
        } catch {
          // Swallowed on purpose — see above.
        }
      }
    }
    if (!retake) {
      options.signal?.removeEventListener('abort', onRunAbort);
      if (leaseLost) {
        result.error = 'the receive lease was taken by another process — this account stopped receiving';
      }
      return stopped('aborted');
    }
    // A fresh stop signal for the next cycle, still bound to the run's own abort.
    stop = new AbortController();
    options.signal?.removeEventListener('abort', onRunAbort);
    options.signal?.addEventListener('abort', onRunAbort);
    attempt = 0;
  }
}

/**
 * Receive what every account of one delivery backend has queued, and write it to the index.
 *
 * `catch-up` walks the accounts one after another: a bounded run reports per account, and one
 * slow account must not eat the whole budget. `follow` runs them all at once — a follow session
 * ends only when it is closed, so a queue would starve every account behind the first.
 */
export async function receiveDeliveries(
  db: IndexDatabase,
  backend: DeliveryBackend,
  options: DeliverySyncOptions = {},
): Promise<DeliverySyncResult> {
  const mode = options.mode ?? 'catch-up';
  const accounts = (await backend.listAccounts()).filter(
    (a) => !options.accountId || a.id === options.accountId,
  );
  // The lease is taken inside `receiveAccount`, by both modes — that is the only place that
  // connects an account, so it is the only place that has to hold it.
  const settled = new Map<string, DeliveryAccountSyncResult>();
  if (mode === 'follow') {
    // Every account at once: a follow session ends only when it is closed, so a queue would
    // starve every account behind the first.
    await Promise.all(
      accounts.map(async (account) => {
        settled.set(account.id, await receiveAccount(db, backend, account, options));
      }),
    );
  } else {
    // `catch-up` stays sequential: a bounded run reports per account, and one slow account must
    // not eat the whole budget.
    for (const account of accounts) {
      settled.set(account.id, await receiveAccount(db, backend, account, options));
    }
  }
  const results = accounts.map((account) => settled.get(account.id) as DeliveryAccountSyncResult);
  const errors = results.filter((r) => r.error !== null).length;
  return {
    accounts: results,
    added: results.reduce((n, r) => n + r.added, 0),
    removed: results.reduce((n, r) => n + r.removed, 0),
    errors,
    failed: results.length > 0 && errors === results.length,
  };
}
