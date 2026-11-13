/**
 * Conversations, participants and their messages — mail threads derived from the mail index,
 * chats written by `syncChats` — read by the CLI and MCP.
 *
 * `rebuildConversations` runs after a sync and rewrites the mail part of these tables, the
 * participant directory, and the chats' links into it, in one transaction. A full rebuild rather than an incremental update, on purpose: threading is a
 * union over the whole mailbox (a late reply can join two threads that were apart), and the
 * classification of one message depends on the rest of its thread (did the user reply?). An
 * incremental version would have to redo exactly that, with more ways to drift.
 *
 * The reads apply the user's per-sender overrides at query time. They come from the config, not
 * the index, so correcting a sender never writes here — only `curlew sync` does.
 */

import type {
  Classification,
  ClassificationReason,
  ContactDTO,
  Conversation,
  ConversationMessage,
  MailAddress,
  MessageRef,
  Participant,
  ParticipantAddress,
} from '@curlew/protocol';
import { appendChangesTransaction } from './changes.ts';
import { normalizeAddress } from '@curlew/protocol';
import { classifyMail, conversationVerdict, type MessageVerdict, type SenderOverrides } from './classify.ts';
import type { IndexDatabase } from './db.ts';
import { insertMany, placeholders, seqColumn, type SqlValue, withTransaction } from './db.ts';
import { messageBody } from './index-store.ts';
import { buildThreads, normalizeSubject, stableId, type ThreadMember } from './threads.ts';

const MAIL_BACKEND = 'mail';

export interface RebuildOptions {
  /** The address book, for `known-contact` and to link participants to their EDS contact. */
  contacts?: readonly ContactDTO[];
  /** The user's own addresses, beyond the account identities the index already knows. */
  selfAddresses?: readonly string[];
  /**
   * Called after every committed write chunk, with no transaction open. The rebuild holds the
   * write lock only inside a chunk; this is where a test (or a caller that wants to yield) can
   * act as another writer.
   */
  onChunk?: () => void;
}

export interface RebuildResult {
  conversations: number;
  messages: number;
  participants: number;
}

interface MailRow extends ThreadMember {
  folderPath: string;
  uid: number;
  subject: string | null;
  sender: string;
  seen: boolean;
  hasAttachment: boolean;
  from: MailAddress[];
  recipients: MailAddress[];
  listId: string | null;
  listUnsubscribe: string | null;
  autoSubmitted: string | null;
  precedence: string | null;
  emailChat: boolean;
  encrypted: boolean;
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseAddresses(json: unknown): MailAddress[] {
  if (typeof json !== 'string' || !json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((a): a is MailAddress => typeof (a as MailAddress)?.email === 'string')
      : [];
  } catch {
    // upsertMessage writes this with JSON.stringify, so a parse failure means a damaged row.
    // One damaged row must not abort the rebuild of every conversation: it gets no participants.
    return [];
  }
}

function loadMailRows(db: IndexDatabase): MailRow[] {
  const rows = db
    .prepare(
      `SELECT account_id, folder_path, uid, message_id, subject, sender, date, internal_date, seen,
              has_attachment, in_reply_to, thread_refs, from_json, to_json, list_id,
              list_unsubscribe, auto_submitted, precedence, email_chat, encrypted
         FROM messages ORDER BY id`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    key: `${String(r.folder_path)}/${String(r.uid)}`,
    accountId: String(r.account_id),
    folderPath: String(r.folder_path),
    uid: Number(r.uid),
    messageId: str(r.message_id),
    inReplyTo: str(r.in_reply_to),
    references: (str(r.thread_refs) ?? '').split(' ').filter(Boolean),
    sentAt: str(r.date) ?? str(r.internal_date),
    subject: str(r.subject),
    sender: String(r.sender ?? ''),
    seen: Number(r.seen) === 1,
    hasAttachment: Number(r.has_attachment) === 1,
    from: parseAddresses(r.from_json),
    recipients: parseAddresses(r.to_json),
    listId: str(r.list_id),
    listUnsubscribe: str(r.list_unsubscribe),
    autoSubmitted: str(r.auto_submitted),
    precedence: str(r.precedence),
    emailChat: Number(r.email_chat) === 1,
    encrypted: Number(r.encrypted) === 1,
  }));
}

interface DirectoryEntry {
  id: string;
  name: string | null;
  contactUid: string | null;
}

/** Participants keyed by address, merged through the address book. */
class ParticipantDirectory {
  readonly byAddress = new Map<string, DirectoryEntry>();
  readonly addresses = new Map<string, ParticipantAddress[]>();
  /** Entries with no address at all (a chat peer the network gave none); `byAddress` has the rest. */
  private readonly unaddressed = new Map<string, DirectoryEntry>();

  constructor(contacts: readonly ContactDTO[]) {
    // A contact owns ALL its addresses up front, so mail from any of them lands on one person —
    // and the phone numbers are already there for the chat backends that identify by them.
    for (const contact of contacts) {
      const id = stableId('p-', 'contact', contact.uid);
      const owned: ParticipantAddress[] = [];
      const claim = (kind: ParticipantAddress['kind'], raw: string) => {
        const value = normalizeAddress(kind, raw);
        const key = value ? `${kind}:${value}` : null;
        if (!value || !key || this.byAddress.has(key)) return;
        this.byAddress.set(key, { id, name: contact.name || null, contactUid: contact.uid });
        owned.push({ kind, value });
      };
      for (const email of contact.emails) claim('email', email);
      for (const phone of contact.phones) claim('phone', phone);
      for (const jid of contact.jids ?? []) claim('jid', jid);
      if (owned.length > 0) this.addresses.set(id, owned);
    }
  }

  isKnown(email: string): boolean {
    return this.byAddress.get(`email:${email}`)?.contactUid != null;
  }

  /** The participant for a mail address, created on first sight. */
  resolve(address: MailAddress): { id: string; name: string | null; email: string } | null {
    const email = normalizeAddress('email', address.email);
    if (!email) return null;
    const key = `email:${email}`;
    let entry = this.byAddress.get(key);
    if (!entry) {
      entry = { id: stableId('p-', 'email', email), name: address.name, contactUid: null };
      this.byAddress.set(key, entry);
      this.addresses.set(entry.id, [{ kind: 'email', value: email }]);
    } else if (!entry.name && address.name) {
      entry.name = address.name;
    }
    return { id: entry.id, name: entry.name, email };
  }

  /**
   * The participant for a chat peer. An address someone already owns decides who it is — a
   * contact's phone number first, so a Telegram user whose number is in the address book IS
   * that contact, then any other (the same user seen from a second account). Every address of
   * the peer is then claimed for that participant, unless another one already owns it.
   */
  resolvePeer(scope: string, peerId: string, name: string | null, addresses: ParticipantAddress[]): string {
    const owners = addresses
      .flatMap((a) => [
        this.byAddress.get(`${a.kind}:${a.value}`),
        // A JID that is letter for letter a contact's mail address is that contact: most
        // people's XMPP and mail accounts share the provider. Only a CONTACT's address counts —
        // someone who merely mailed from it is no proof.
        a.kind === 'jid' ? this.contactOwner(`email:${a.value}`) : undefined,
      ])
      .filter((e): e is DirectoryEntry => e !== undefined);
    let entry = owners.find((e) => e.contactUid !== null) ?? owners[0];
    if (!entry) {
      const first = addresses[0];
      const id = first ? stableId('p-', first.kind, first.value) : stableId('p-', 'peer', scope, peerId);
      entry = { id, name, contactUid: null };
      if (!first) {
        this.unaddressed.set(id, entry);
        return id;
      }
    } else if (!entry.name && name) {
      entry.name = name;
    }
    for (const address of addresses) {
      const key = `${address.kind}:${address.value}`;
      if (this.byAddress.has(key)) continue;
      this.byAddress.set(key, entry);
      const owned = this.addresses.get(entry.id) ?? [];
      owned.push(address);
      this.addresses.set(entry.id, owned);
    }
    return entry.id;
  }

  private contactOwner(key: string): DirectoryEntry | undefined {
    const entry = this.byAddress.get(key);
    return entry?.contactUid ? entry : undefined;
  }

  participants(): DirectoryEntry[] {
    const seen = new Map<string, DirectoryEntry>();
    for (const entry of [...this.byAddress.values(), ...this.unaddressed.values()]) {
      if (!seen.has(entry.id)) seen.set(entry.id, entry);
    }
    return [...seen.values()];
  }
}

function selfAddressSet(db: IndexDatabase, extra: readonly string[]): Set<string> {
  const rows = db.prepare('SELECT identity FROM accounts').all() as Array<{ identity?: string | null }>;
  const self = new Set<string>();
  for (const raw of [...rows.map((r) => r.identity ?? ''), ...extra]) {
    const email = normalizeAddress('email', raw);
    if (email) self.add(email);
  }
  return self;
}

interface ChatPeerRow {
  backend: string;
  accountId: string;
  peerId: string;
  name: string | null;
  addresses: ParticipantAddress[];
}

function loadChatPeers(db: IndexDatabase): ChatPeerRow[] {
  const rows = db
    .prepare(
      'SELECT backend, account_id, peer_id, display_name, addresses_json FROM chat_peers ORDER BY backend, account_id, peer_id',
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => {
    let addresses: ParticipantAddress[] = [];
    try {
      const parsed = JSON.parse(String(r.addresses_json ?? '[]')) as unknown;
      if (Array.isArray(parsed)) {
        addresses = parsed.filter(
          (a): a is ParticipantAddress => typeof a?.kind === 'string' && typeof a?.value === 'string',
        );
      }
    } catch {
      // Written with JSON.stringify by syncChats; a damaged row gets a participant without addresses.
    }
    return {
      backend: String(r.backend),
      accountId: String(r.account_id),
      peerId: String(r.peer_id),
      name: str(r.display_name),
      addresses,
    };
  });
}

/** A derived table the rebuild keeps equal to computed rows, writing only the difference. */
interface SyncedTable {
  table: string;
  columns: readonly string[];
  /** Indexes into `columns` of the primary key. */
  key: readonly number[];
}

const PARTICIPANTS: SyncedTable = {
  table: 'participants',
  columns: ['id', 'display_name', 'contact_uid'],
  key: [0],
};
const PARTICIPANT_ADDRESSES: SyncedTable = {
  table: 'participant_addresses',
  columns: ['participant_id', 'kind', 'value'],
  key: [1, 2],
};
const CHAT_PEER_LINKS: SyncedTable = {
  table: 'chat_peer_links',
  columns: ['backend', 'account_id', 'peer_id', 'participant_id'],
  key: [0, 1, 2],
};
const CONVERSATIONS: SyncedTable = {
  table: 'conversations',
  columns: [
    'id',
    'backend',
    'account_id',
    'kind',
    'title',
    'classification',
    'classification_reason',
    'first_message_at',
    'last_message_at',
    'message_count',
    'unread_count',
    'has_attachments',
    'email_chat',
  ],
  key: [0],
};
const CONVERSATION_PARTICIPANTS: SyncedTable = {
  table: 'conversation_participants',
  columns: ['conversation_id', 'participant_id'],
  key: [0, 1],
};
const MAIL_MESSAGES: SyncedTable = {
  table: 'conversation_messages',
  columns: [
    'id',
    'conversation_id',
    'backend',
    'account_id',
    'presentation',
    'sender_participant_id',
    'sender_name',
    'sender_kind',
    'sender_address',
    'from_self',
    'sent_at',
    'subject',
    'seen',
    'has_attachments',
    'classification',
    'classification_reason',
    'folder_path',
    'uid',
    'email_chat',
    'encrypted',
  ],
  key: [0],
};

type Sync = (table: SyncedTable, rows: SqlValue[][], scope?: string, params?: SqlValue[]) => number;

/** Rows per write transaction: a few milliseconds of lock, however large the table. */
const WRITE_CHUNK = 500;

const cell = (v: unknown): string => (v === null || v === undefined ? '\u0000' : String(v));
const tuple = (row: readonly unknown[], at?: readonly number[]): string =>
  (at ? at.map((i) => cell(row[i])) : row.map(cell)).join('\u0001');

/**
 * Make the rows of `table` inside `scope` equal `wanted`: delete what is gone, replace what is
 * new or changed, leave the rest. Each chunk is its own transaction, so no writer waits longer
 * than a chunk; the reads need no lock at all (WAL). An unchanged table opens no transaction.
 * Returns how many rows it deleted or replaced, so the caller can tell a rebuild that changed
 * something from one that did not (the change journal, ADR 0007).
 */
function syncTable(
  db: IndexDatabase,
  def: SyncedTable,
  wanted: readonly SqlValue[][],
  scope = '1',
  params: SqlValue[] = [],
  onChunk?: () => void,
): number {
  const want = new Map<string, SqlValue[]>();
  for (const row of wanted) {
    const key = tuple(row, def.key);
    if (!want.has(key)) want.set(key, row);
  }
  const have = new Map<string, string>();
  const gone: SqlValue[][] = [];
  const stored = db
    .prepare(`SELECT ${def.columns.join(', ')} FROM ${def.table} WHERE ${scope}`)
    .all(...params) as Array<Record<string, unknown>>;
  for (const r of stored) {
    const row = def.columns.map((c) => r[c]);
    const key = tuple(row, def.key);
    have.set(key, tuple(row));
    if (!want.has(key)) gone.push(def.key.map((i) => row[i] as SqlValue));
  }
  const changed: SqlValue[][] = [];
  for (const [key, row] of want) if (have.get(key) !== tuple(row)) changed.push(row);

  const where = def.key.map((i) => `${def.columns[i]} = ?`).join(' AND ');
  for (let i = 0; i < gone.length; i += WRITE_CHUNK) {
    withTransaction(db, () => {
      const del = db.prepare(`DELETE FROM ${def.table} WHERE ${where}`);
      for (const key of gone.slice(i, i + WRITE_CHUNK)) del.run(...key);
    });
    onChunk?.();
  }
  for (let i = 0; i < changed.length; i += WRITE_CHUNK) {
    withTransaction(db, () =>
      insertMany(
        db,
        `INSERT OR REPLACE INTO ${def.table} (${def.columns.join(', ')})`,
        changed.slice(i, i + WRITE_CHUNK),
      ),
    );
    onChunk?.();
  }
  return gone.length + changed.length;
}

/**
 * `UPDATE conversation_messages SET <set> WHERE <where>`, only if a row matches (no lock otherwise).
 * True when it ran.
 */
function updateIfAny(db: IndexDatabase, where: string, set: string): boolean {
  if (!db.prepare(`SELECT 1 AS hit FROM conversation_messages WHERE ${where} LIMIT 1`).get()) return false;
  withTransaction(db, () => db.exec(`UPDATE conversation_messages SET ${set} WHERE ${where}`));
  return true;
}

/**
 * Rewrite the mail conversations, their messages and the participant directory from the index,
 * and re-link the chat conversations to that directory.
 *
 * Chat messages themselves are not rewritten (`syncChats` writes them once; a chat history is
 * too large to rebuild on every sync). Their links are: a set-based handful of statements, so a
 * contact added to the address book turns a chat peer into that contact on the next sync.
 * Idempotent: running it twice yields the same rows and the same ids.
 */
export function rebuildConversations(db: IndexDatabase, options: RebuildOptions = {}): RebuildResult {
  const rows = loadMailRows(db);
  const self = selfAddressSet(db, options.selfAddresses ?? []);
  const directory = new ParticipantDirectory(options.contacts ?? []);
  const threads = buildThreads(rows);

  // Every row is computed first and written afterwards in multi-row INSERTs. One statement per
  // row made this 5 000 executions for a 5 000-message mailbox, and on gjsify's libgda-backed
  // `node:sqlite` each execution costs three round trips plus objects that the GC frees late.
  const messageRows: SqlValue[][] = [];
  const conversationRows: SqlValue[][] = [];
  const memberRows: SqlValue[][] = [];

  for (const thread of threads) {
    const conversationId = stableId('c-', MAIL_BACKEND, thread.accountId, thread.rootKey);
    const senderEmail = (row: MailRow) => normalizeAddress('email', row.from[0]?.email ?? '');
    const repliedInThread = thread.members.some((row) => {
      const email = senderEmail(row);
      return email !== null && self.has(email);
    });

    const others = new Set<string>();
    const verdicts: MessageVerdict[] = [];
    let unread = 0;
    let attachments = false;

    for (const row of thread.members) {
      const email = senderEmail(row);
      const fromSelf = email !== null && self.has(email);
      const sender = row.from[0] ? directory.resolve(row.from[0]) : null;
      for (const address of [...row.from, ...row.recipients]) {
        const participant = directory.resolve(address);
        if (participant && !self.has(participant.email)) others.add(participant.id);
      }
      const verdict = classifyMail({
        fromSelf,
        senderAddress: email,
        automation: {
          listId: row.listId,
          listUnsubscribe: row.listUnsubscribe,
          autoSubmitted: row.autoSubmitted,
          precedence: row.precedence,
        },
        knownContact: email !== null && directory.isKnown(email),
        repliedInThread,
      });
      verdicts.push({
        fromSelf,
        senderAddress: email,
        classification: verdict.classification,
        reason: verdict.reason,
      });
      if (!fromSelf && !row.seen) unread++;
      if (row.hasAttachment) attachments = true;

      messageRows.push([
        stableId('m-', conversationId, row.messageId ?? row.key),
        conversationId,
        MAIL_BACKEND,
        row.accountId,
        // Mail stays mail in presentation (ADR 0001 §1): a card with subject and attachments.
        'document',
        fromSelf ? null : (sender?.id ?? null),
        sender?.name ?? (row.from[0] ? null : row.sender || null),
        email ? 'email' : null,
        email,
        fromSelf ? 1 : 0,
        row.sentAt,
        row.subject,
        row.seen ? 1 : 0,
        row.hasAttachment ? 1 : 0,
        verdict.classification,
        verdict.reason,
        row.folderPath,
        row.uid,
        row.emailChat ? 1 : 0,
        row.encrypted ? 1 : 0,
      ]);
    }

    const summary = conversationVerdict(verdicts);
    const first = thread.members[0];
    const last = thread.members[thread.members.length - 1];
    conversationRows.push([
      conversationId,
      MAIL_BACKEND,
      thread.accountId,
      others.size > 1 ? 'group' : 'direct',
      normalizeSubject(thread.members.find((m) => m.subject)?.subject ?? null),
      summary.classification,
      summary.reason,
      first.sentAt,
      last.sentAt,
      thread.members.length,
      unread,
      attachments ? 1 : 0,
      thread.members.some((row) => row.emailChat) ? 1 : 0,
    ]);
    for (const participantId of others) memberRows.push([conversationId, participantId]);
  }

  // Chat peers join the same directory, after mail, so mail and chat meet at the address book.
  const peerLinkRows: SqlValue[][] = [];
  for (const peer of loadChatPeers(db)) {
    const participantId = directory.resolvePeer(
      `${peer.backend}\u0000${peer.accountId}`,
      peer.peerId,
      peer.name,
      peer.addresses,
    );
    peerLinkRows.push([peer.backend, peer.accountId, peer.peerId, participantId]);
  }

  // Memberships are joined here, and written with REPLACE (two peers can resolve to one
  // contact): libgda logs a warning for every insert that inserts nothing — an INSERT … SELECT
  // of zero rows, an IGNORE that ignores — when it looks for the "last inserted row".
  const linkOf = new Map(peerLinkRows.map((r) => [`${r[0]}\u0000${r[1]}\u0000${r[2]}`, r[3]]));
  const chatMemberRows: SqlValue[][] = [];
  if (peerLinkRows.length > 0) {
    const members = db
      .prepare('SELECT conversation_id, backend, account_id, peer_id FROM chat_members')
      .all() as Array<Record<string, unknown>>;
    for (const m of members) {
      const participantId = linkOf.get(
        `${String(m.backend)}\u0000${String(m.account_id)}\u0000${String(m.peer_id)}`,
      );
      if (participantId) chatMemberRows.push([String(m.conversation_id), participantId]);
    }
  }

  const participants = directory.participants();
  const participantRows = participants.map((p): SqlValue[] => [p.id, p.name, p.contactUid]);
  const addressRows = participants.flatMap((p) =>
    (directory.addresses.get(p.id) ?? []).map((a): SqlValue[] => [p.id, a.kind, a.value]),
  );

  // Only rows that differ from what is stored are written, in short transactions of their own.
  // The old form deleted and re-inserted every mail row in ONE transaction: with ~90 000
  // conversations that held the write lock for minutes, and a `curlew send` (or any other
  // writer) timed out against the daemon. A steady-state rebuild now changes nothing.
  // Readers never see an empty table; they may see the directory a step ahead of the messages.
  let changes = 0;
  const sync: Sync = (table, rows, scope, params) => {
    const n = syncTable(db, table, rows, scope, params, options.onChunk);
    changes += n;
    return n;
  };
  sync(PARTICIPANTS, participantRows);
  sync(PARTICIPANT_ADDRESSES, addressRows);
  sync(CHAT_PEER_LINKS, peerLinkRows);
  // Members before conversations: a vanished conversation is still in the scope subquery then.
  sync(
    CONVERSATION_PARTICIPANTS,
    memberRows,
    'conversation_id IN (SELECT id FROM conversations WHERE backend = ?)',
    [MAIL_BACKEND],
  );
  sync(CONVERSATIONS, conversationRows, 'backend = ?', [MAIL_BACKEND]);
  sync(MAIL_MESSAGES, messageRows, 'backend = ?', [MAIL_BACKEND]);

  // Chats: point every message and membership at the rebuilt directory. A chat conversation
  // is one with a cursor — the store tells chat from mail by driver data, not by name.
  // Skipped without chat peers: nothing to link. Each UPDATE names only rows whose value
  // would change, so an unchanged directory writes nothing.
  if (peerLinkRows.length > 0) {
    const linked = `(SELECT l.participant_id FROM chat_peer_links l
         WHERE l.backend = conversation_messages.backend AND l.account_id = conversation_messages.account_id
           AND l.peer_id = conversation_messages.sender_peer_id)`;
    if (
      updateIfAny(
        db,
        `sender_peer_id IS NOT NULL AND COALESCE(sender_participant_id, '') != COALESCE(${linked}, '')`,
        `sender_participant_id = ${linked}`,
      )
    ) {
      changes++;
    }
    // A chat message from a contact is `known-contact`, from anyone else in the chat
    // `chat-member`. Automated verdicts (broadcast, bot) are the network's own and stay.
    const reason = `CASE
         WHEN sender_participant_id IN (SELECT id FROM participants WHERE contact_uid IS NOT NULL) THEN 'known-contact'
         ELSE 'chat-member' END`;
    if (
      updateIfAny(
        db,
        `sender_peer_id IS NOT NULL AND from_self = 0 AND classification = 'conversational' AND classification_reason != ${reason}`,
        `classification_reason = ${reason}`,
      )
    ) {
      changes++;
    }
    sync(
      CONVERSATION_PARTICIPANTS,
      chatMemberRows,
      'conversation_id IN (SELECT conversation_id FROM chat_cursors)',
    );
  }

  // One row per rebuild that changed something: which conversations is not worth computing.
  if (changes > 0) appendChangesTransaction(db, [{ kind: 'conversations' }]);

  return { conversations: threads.length, messages: messageRows.length, participants: participants.length };
}

// ── reads ──────────────────────────────────────────────────────────────

export interface ConversationQuery {
  /** Only conversations with a person in them (ADR 0001: `--people-only`). */
  peopleOnly?: boolean;
  accountId?: string;
  backend?: string;
  /** Every protocol but this one: a window lists chats whole and mail by its own limit. */
  excludeBackend?: string;
  /** Only mail threads that are email chats (Chat-Version), so newsletters do not fill the limit. */
  emailChat?: boolean;
  limit?: number;
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
        ORDER BY last_message_at DESC, id LIMIT ?`,
    )
    .all(...params, query.limit ?? DEFAULT_LIST_LIMIT) as Array<Record<string, unknown>>;
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
                m.subject, m.has_attachments, m.sender_name
           FROM conversation_messages m
          WHERE m.conversation_id IN (${chunk.map(() => '?').join(',')})
            AND m.id = (SELECT n.id FROM conversation_messages n
                         WHERE n.conversation_id = m.conversation_id
                         ORDER BY n.sent_at DESC, n.id DESC LIMIT 1)`,
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

/** Fills `reactions` on the chat messages among `messages`, one query for all of them. */
function attachReactions(db: IndexDatabase, messages: ConversationMessage[]): void {
  const chat = messages.filter((m) => m.editedAt !== undefined);
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
 * Records the person's own reaction on a message once the network took it: their rows go, and
 * `emoji` (when not null) becomes the one. The network's own echo, if any, lands on the same key.
 */
export function setOwnReaction(db: IndexDatabase, messageId: string, emoji: string | null): void {
  db.prepare("DELETE FROM message_reactions WHERE message_id = ? AND reactor = ''").run(messageId);
  if (emoji === null) return;
  db.prepare("INSERT OR REPLACE INTO message_reactions (message_id, reactor, emoji) VALUES (?, '', ?)").run(
    messageId,
    emoji,
  );
}

/**
 * Updates a chat message's body and edited timestamp. Returns true when the row existed and was
 * changed; false when the id was not a chat message (mail bodies live in the FTS table).
 */
export function setMessageText(db: IndexDatabase, messageId: string, text: string): boolean {
  const result = db
    .prepare("UPDATE conversation_messages SET body = ?, edited_at = ? WHERE id = ? AND remote_seq IS NOT NULL")
    .run(text, new Date().toISOString(), messageId);
  return result.changes > 0;
}

const MESSAGE_COLUMNS = `id, conversation_id, backend, account_id, presentation, sender_participant_id, sender_name,
              sender_kind, sender_address, from_self, sent_at, subject, seen, has_attachments,
              classification, classification_reason, folder_path, uid, remote_id, email_chat, encrypted, ${seqColumn('remote_seq')}, body,
              edited_at, reply_to_remote_id, thread_remote_id, reply_to_client_id, group_id, client_id, peer_read`;

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
    senderName: str(r.sender_name),
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
  if (chat) {
    message.editedAt = str(r.edited_at);
    message.replyToRemoteId = str(r.reply_to_remote_id);
    message.replyToClientId = str(r.reply_to_client_id);
    message.threadRemoteId = str(r.thread_remote_id);
    message.groupId = str(r.group_id) || null;
    message.clientId = str(r.client_id);
    if (message.fromSelf) message.readByPeer = Number(r.peer_read) === 1;
  }
  // A notice is what the network said about the chat: shown with or without bodies.
  if (message.presentation === 'notice') message.notice = str(r.body);
  if (options.includeBodies) {
    // Mail keeps its body once, in the FTS table; a chat message keeps it on its own row.
    const body =
      folder && uid !== undefined
        ? messageBody(db, message.ref.accountId, folder, uid)
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

function tri(value: unknown): boolean | null {
  return value === null || value === undefined ? null : Number(value) === 1;
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
