/**
 * Conversation rebuild: derives the participant directory, mail conversations and their messages
 * from the mail index, and re-links chat peers to the directory.
 *
 * `rebuildConversations` runs after a sync and rewrites the mail part of these tables, the
 * participant directory, and the chats' links into it, in one transaction. A full rebuild rather
 * than an incremental update, on purpose: threading is a union over the whole mailbox (a late reply
 * can join two threads that were apart), and the classification of one message depends on the rest
 * of its thread (did the user reply?). An incremental version would have to redo exactly that, with
 * more ways to drift.
 */

import type {
  ContactDTO,
  MailAddress,
  ParticipantAddress,
} from '@curlew/protocol';
import { appendChangesTransaction } from './changes.ts';
import { normalizeAddress } from '@curlew/protocol';
import { classifyMail, conversationVerdict, type MessageVerdict } from './classify.ts';
import type { IndexDatabase } from './db.ts';
import { insertMany, type SqlValue, withTransaction } from './db.ts';
import { fillSearchKeys } from './search-key-fill.ts';
import { messageBody } from './index-store.ts';
import { buildThreads, normalizeSubject, stableId, type ThreadMember } from './threads.ts';
import { parseParticipantAddresses, str } from './row.ts';
import { loadLocalReadStates, readLocally } from './local-read.ts';
import { MAIL_BACKEND, PENDING_DELETE, PENDING_DELETE_TTL_MS, setOwnReaction } from './conversations-shared.ts';

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
  reaction: boolean;
  chatEdit: string | null;
  chatDelete: string | null;
  mdn: boolean;
  mdnFor: string | null;
  receiptTo: string | null;
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
              list_unsubscribe, auto_submitted, precedence, email_chat, encrypted, reaction, chat_edit, chat_delete,
              mdn, mdn_for, receipt_to
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
    reaction: Number(r.reaction) === 1,
    chatEdit: str(r.chat_edit),
    chatDelete: str(r.chat_delete),
    mdn: Number(r.mdn) === 1,
    mdnFor: str(r.mdn_for),
    receiptTo: str(r.receipt_to),
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

/**
 * The person's own mail addresses, per account. A mail from the person's OTHER account is a peer
 * message here: two own addresses talking to each other is a chat between two people from each
 * account's point of view, and only its Sent copy is "from self".
 */
class SelfAddresses {
  private readonly byAccount = new Map<string, Set<string>>();
  private readonly extra = new Set<string>();

  constructor(db: IndexDatabase, extra: readonly string[]) {
    const rows = db.prepare('SELECT id, identity FROM accounts').all() as Array<{ id?: string; identity?: string | null }>;
    for (const row of rows) {
      const email = normalizeAddress('email', row.identity ?? '');
      if (email && row.id) this.byAccount.set(row.id, new Set([email]));
    }
    for (const raw of extra) {
      const email = normalizeAddress('email', raw);
      if (email) this.extra.add(email);
    }
  }

  has(accountId: string, email: string): boolean {
    return this.extra.has(email) || (this.byAccount.get(accountId)?.has(email) ?? false);
  }
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
  return rows.map((r) => ({
    backend: String(r.backend),
    accountId: String(r.account_id),
    peerId: String(r.peer_id),
    name: str(r.display_name),
    addresses: parseParticipantAddresses(r.addresses_json),
  }));
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
const MAIL_REACTIONS: SyncedTable = {
  table: 'message_reactions',
  columns: ['message_id', 'reactor', 'emoji'],
  key: [0, 1, 2],
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
    'remote_id',
    'body',
    'edited_at',
    'peer_read',
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
  const all = loadMailRows(db);
  const self = new SelfAddresses(db, options.selfAddresses ?? []);
  // A reaction, edit or delete mail is no message of the thread: it acts on its target.
  const controls = mailControls(db, all);
  const pending = pendingDeletes(db, all, controls);
  const rows = all.filter(
    (row) =>
      !row.reaction &&
      !row.chatEdit &&
      !row.chatDelete &&
      !row.mdn &&
      !controls.deleted.has(row.key) &&
      !(row.messageId && pending.has(row.messageId)),
  );
  // A read receipt from someone else confirms the message it names was read; ours confirm nothing.
  const receipted = new Set<string>();
  for (const row of all) {
    const from = normalizeAddress('email', row.from[0]?.email ?? '');
    if (row.mdn && row.mdnFor && !(from !== null && self.has(row.accountId, from))) receipted.add(row.mdnFor);
  }
  // The person's own edit, echoed locally before its mail was synced, stays until a mail says otherwise.
  const echoed = new Map<string, { body: SqlValue; editedAt: SqlValue }>();
  for (const r of db
    .prepare("SELECT id, body, edited_at FROM conversation_messages WHERE backend = ? AND edited_at IS NOT NULL")
    .all(MAIL_BACKEND) as Array<Record<string, unknown>>) {
    echoed.set(String(r.id), { body: r.body as SqlValue, editedAt: r.edited_at as SqlValue });
  }
  const localRead = loadLocalReadStates(db);
  const directory = new ParticipantDirectory(options.contacts ?? []);
  const threads = buildThreads(rows);

  // Every row is computed first and written afterwards in multi-row INSERTs. One statement per
  // row made this 5 000 executions for a 5 000-message mailbox, and on gjsify's libgda-backed
  // `node:sqlite` each execution costs three round trips plus objects that the GC frees late.
  const messageRows: SqlValue[][] = [];
  const conversationRows: SqlValue[][] = [];
  const memberRows: SqlValue[][] = [];
  const idByMessageId = new Map<string, string>();

  for (const thread of threads) {
    const conversationId = stableId('c-', MAIL_BACKEND, thread.accountId, thread.rootKey);
    const senderEmail = (row: MailRow) => normalizeAddress('email', row.from[0]?.email ?? '');
    const repliedInThread = thread.members.some((row) => {
      const email = senderEmail(row);
      return email !== null && self.has(thread.accountId, email);
    });

    const others = new Set<string>();
    const verdicts: MessageVerdict[] = [];
    let unread = 0;
    let attachments = false;

    for (const row of thread.members) {
      const email = senderEmail(row);
      const fromSelf = email !== null && self.has(thread.accountId, email);
      const sender = row.from[0] ? directory.resolve(row.from[0]) : null;
      for (const address of [...row.from, ...row.recipients]) {
        const participant = directory.resolve(address);
        if (participant && !self.has(thread.accountId, participant.email)) others.add(participant.id);
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
      const seenHere = row.seen || (!fromSelf && readLocally(row.sentAt, localRead.get(conversationId)?.readThrough ?? null));
      if (!fromSelf && !seenHere) unread++;
      if (row.hasAttachment) attachments = true;

      const id = stableId('m-', conversationId, row.messageId ?? row.key);
      if (row.messageId) idByMessageId.set(row.messageId, id);
      messageRows.push([
        id,
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
        seenHere ? 1 : 0,
        row.hasAttachment ? 1 : 0,
        verdict.classification,
        verdict.reason,
        row.folderPath,
        row.uid,
        row.emailChat ? 1 : 0,
        row.encrypted ? 1 : 0,
        // Mail's own id, so a reaction or an edit can name the message it is about.
        row.messageId,
        ...editedOf(controls.edits.get(row.key), echoed.get(id)),
        // Only a Delta Chat message of ours shows the tick; NULL elsewhere keeps old rows unchanged.
        fromSelf && row.emailChat && row.messageId && receipted.has(row.messageId) ? 1 : null,
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
      localRead.get(conversationId)?.markedUnread ? Math.max(unread, 1) : unread,
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
  const reactions = mailReactions(db, all.filter((row) => row.reaction), idByMessageId, self);
  // Before the messages: a deleted message is still in the scope subquery, so its reactions go too.
  sync(
    MAIL_REACTIONS,
    reactions.others,
    "reactor != '' AND message_id IN (SELECT id FROM conversation_messages WHERE backend = ?)",
    [MAIL_BACKEND],
  );
  sync(MAIL_MESSAGES, messageRows, 'backend = ?', [MAIL_BACKEND]);
  // Replaced rows came back without a search key; compute them in short transactions too.
  for (let n = 1; n > 0; ) {
    n = withTransaction(db, () => fillSearchKeys(db, 500));
  }
  for (const [target, emoji] of reactions.own) setOwnReaction(db, target, emoji);

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

interface MailControls {
  /** Mail rows a `Chat-Delete` took away, by `key`. */
  deleted: Set<string>;
  /** The newest `Chat-Edit` text per mail row, by `key`. */
  edits: Map<string, { text: string; at: string | null }>;
}

/**
 * What `Chat-Edit` and `Chat-Delete` mails ask for. Only the author of a message can change it, so a
 * request from anyone else is ignored, as is one that names a message the index does not hold or one
 * that is not part of a Delta Chat thread (nothing but an email chat is edited or deleted by mail).
 */
function mailControls(db: IndexDatabase, all: readonly MailRow[]): MailControls {
  const byId = new Map<string, MailRow>();
  for (const row of all) {
    if (row.messageId && !row.reaction && !row.chatEdit && !row.chatDelete && !row.mdn) byId.set(row.messageId, row);
  }
  const author = (row: MailRow) => normalizeAddress('email', row.from[0]?.email ?? '');
  const result: MailControls = { deleted: new Set(), edits: new Map() };
  const sentAt = (row: MailRow) => Date.parse(row.sentAt ?? '') || 0;
  for (const row of [...all].sort((a, b) => sentAt(a) - sentAt(b))) {
    const named = row.chatDelete ?? row.chatEdit;
    const target = named ? byId.get(named) : undefined;
    if (!target || !target.emailChat || author(target) === null || author(target) !== author(row)) continue;
    if (row.chatDelete) {
      result.deleted.add(target.key);
      continue;
    }
    const text = editedText(messageBody(db, row.accountId, row.folderPath, row.uid) ?? '');
    if (text) result.edits.set(target.key, { text, at: row.sentAt });
  }
  return result;
}

/**
 * The Message-IDs the person deleted for everyone whose `Chat-Delete` mail has not come back yet.
 * Without this the rebuild would put the hidden message back until the IMAP sync catches up. A
 * marker ends when the delete mail is seen, or after 30 days (a sent mail that no synced folder holds).
 */
function pendingDeletes(db: IndexDatabase, all: readonly MailRow[], controls: MailControls): Set<string> {
  const stored = db
    .prepare('SELECT key, value FROM schema_meta WHERE key LIKE ?')
    .all(`${PENDING_DELETE}%`) as Array<Record<string, unknown>>;
  const confirmed = new Set<string>();
  for (const row of all) if (row.messageId && controls.deleted.has(row.key)) confirmed.add(row.messageId);
  const pending = new Set<string>();
  const now = Date.now();
  for (const r of stored) {
    const key = String(r.key);
    const messageId = key.slice(PENDING_DELETE.length);
    const age = now - (Date.parse(String(r.value)) || 0);
    if (confirmed.has(messageId) || age > PENDING_DELETE_TTL_MS) {
      db.prepare('DELETE FROM schema_meta WHERE key = ?').run(key);
    } else {
      pending.add(messageId);
    }
  }
  return pending;
}

/** The new text of an edit mail: the quote and the pencil before it are skipped (chatmail spec, "Request editing"). */
function editedText(body: string): string {
  const pencil = body.lastIndexOf('\u270f');
  const text = pencil === -1 ? body : body.slice(pencil + 1).replace(/^\ufe0f/, '');
  return text.trim();
}

function editedOf(
  edit: { text: string; at: string | null } | undefined,
  echo: { body: SqlValue; editedAt: SqlValue } | undefined,
): [SqlValue, SqlValue] {
  if (edit) return [edit.text, edit.at ?? new Date().toISOString()];
  return echo ? [echo.body, echo.editedAt] : [null, null];
}

/**
 * What the reaction mails of a mailbox leave on their targets (RFC 9078): the last one of each
 * reactor wins, an empty body takes it back, a target the index does not hold is dropped.
 * `own` is the person's own, by message id: those rows are written beside the local echo, not
 * synced, because a sent reaction may not be in any synced folder.
 */
function mailReactions(
  db: IndexDatabase,
  mails: readonly MailRow[],
  idByMessageId: ReadonlyMap<string, string>,
  self: SelfAddresses,
): { others: SqlValue[][]; own: Map<string, string | null> } {
  const sentAt = (row: MailRow) => Date.parse(row.sentAt ?? '') || 0;
  const last = new Map<string, { target: string; reactor: string; emoji: string | null }>();
  for (const row of [...mails].sort((a, b) => sentAt(a) - sentAt(b))) {
    const target = row.inReplyTo ? idByMessageId.get(row.inReplyTo) : undefined;
    const email = normalizeAddress('email', row.from[0]?.email ?? '');
    if (!target || !email) continue;
    const reactor = self.has(row.accountId, email) ? '' : email;
    const body = messageBody(db, row.accountId, row.folderPath, row.uid)?.trim() ?? '';
    if (body.length > 64) continue;
    last.set(`${target}\u0000${reactor}`, { target, reactor, emoji: body || null });
  }
  const others: SqlValue[][] = [];
  const own = new Map<string, string | null>();
  for (const { target, reactor, emoji } of last.values()) {
    if (reactor === '') own.set(target, emoji);
    else if (emoji) others.push([target, reactor, emoji]);
  }
  return { others, own };
}
