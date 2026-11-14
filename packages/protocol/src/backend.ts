/**
 * The backend ports: `MessageBackend` (network-neutral) and `MailBackend` (the mailbox driver).
 *
 * Every backend implements `MessageBackend` — a manifest plus its accounts — and is loaded
 * through the app's registry. HOW its messages are synced is a driver on top, picked by `kind`:
 * `mailbox` (folders, UIDs, UIDVALIDITY — IMAP-shaped, and the reason it is not forced into a
 * chat shape) and `chat` (dialogs with a per-chat monotonic message sequence, for server-archive
 * chat networks: Telegram, Matrix, XMPP with MAM) and `delivery` (events pushed once by a
 * network with no server archive: WhatsApp, later Signal).
 *
 * The `MailBackend` interface is the load-bearing seam of the project. `@curlew/store` drives the sync
 * engine THROUGH it and never imports `@curlew/imap`, which is the only reason the most
 * intricate code here — incremental sync, UIDVALIDITY handling, expunge detection — can be
 * unit-tested on Node against a fake backend and an in-memory database, with no server, no
 * network and no GOA session.
 *
 * If you find yourself wanting to import `imap` from `store`, add a method here instead.
 */

import type { FolderInfo } from './list-parse.ts';
import type { AutomationHeaders } from './mail-headers.ts';
import type { BackendManifest, ParticipantAddress } from './messenger.ts';
import type { MailAddress } from './types.ts';

/** Mailbox cursor state, as reported by SELECT/EXAMINE. */
export interface BackendMailboxStatus {
  uidValidity: number | null;
  uidNext: number | null;
  exists: number;
}

/** One message's indexable metadata, as the backend reports it. */
export interface BackendMessage {
  uid: number;
  messageId: string | null;
  subject: string | null;
  /** Formatted senders, e.g. `Name <a@b.c>`, comma-joined. */
  sender: string;
  /** Formatted To + Cc, comma-joined. */
  recipients: string;
  /** Date header as ISO-8601, or null. */
  date: string | null;
  /** INTERNALDATE (arrival) as ISO-8601, or null. */
  internalDate: string | null;
  size: number | null;
  seen: boolean;
  flagged: boolean;
  hasAttachment: boolean;
  attachments: Array<{ section: string; filename: string | null; mimeType: string; size: number }>;
  /** Plain-text body, already decoded and capped. Null when none could be extracted. */
  bodyText: string | null;
  /** Structured From, To and Cc — the participants of the conversation this message joins. */
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  /** Threading: the parent's Message-ID, and the whole References chain, oldest first. */
  inReplyTo: string | null;
  references: string[];
  /** The headers that mark bulk or machine mail — the classifier's input. */
  automation: AutomationHeaders;
  /** Delta Chat's open email-chat marker (`Chat-Version: 1.0`). */
  emailChat: boolean;
  /** A reaction mail (RFC 9078): it belongs on its target as a reaction, never in the list. */
  reaction?: boolean;
  /** `Chat-Edit` (Delta Chat): this mail replaces the text of the message with that Message-ID. */
  chatEdit?: string;
  /** `Chat-Delete` (Delta Chat): this mail asks to delete the message with that Message-ID. */
  chatDelete?: string;
  /** Only with `emailChat`: the message is a voice note or a sticker (Delta Chat headers). */
  chatContent?: 'voice' | 'sticker';
  /** The voice note's `Chat-Duration` in milliseconds, when it came. */
  durationMs?: number;
  /**
   * A read receipt (MDN, RFC 8098) of the other side: it belongs on the message it confirms as
   * "read", never in the list. `for` is that message's id (`Original-Message-ID`), null when the
   * receipt names none.
   */
  mdn?: { for: string | null };
  /** `Chat-Disposition-Notification-To`: the address that asked for a read receipt of this message. */
  receiptTo?: string;
  /** The body is encrypted (OpenPGP, S/MIME): there is no text to index, and the window says so. */
  encrypted?: boolean;
}

/** Just the parts needed to detect a flag change or an expunge. */
export interface BackendFlagState {
  uid: number;
  seen: boolean;
  flagged: boolean;
}

/** One connected account session. Closed by the engine when it is done. */
export interface BackendSession {
  listFolders(): Promise<FolderInfo[]>;
  /** Open a mailbox READ-ONLY and report its cursor state. */
  openFolder(path: string): Promise<BackendMailboxStatus>;
  /**
   * Fetch indexable metadata + body for every UID strictly greater than `afterUid`.
   * Implementations must not return UIDs at or below it — `<n>:*` always yields at least the
   * highest existing UID even when `n` is past the end, which is the classic RFC 3501 trap.
   */
  fetchNewer(path: string, afterUid: number, batchSize: number): Promise<BackendMessage[]>;
  /** Every live UID with its flags — the set IS the live set, so expunges fall out of it. */
  listFlags(path: string): Promise<BackendFlagState[]>;
  close(): Promise<void>;
}

/** One account the engine can sync. */
export interface BackendAccount {
  id: string;
  identity: string;
  provider: string;
  /**
   * The account's own address(es) on the network, when the backend knows them without opening a
   * secret — a space-separated list when the network has more than one spelling (WhatsApp: the
   * phone-number JID and the LID). Lets a reader that has no access to the account's secrets
   * recognise the chat with oneself. Never a key, a token or a password; absent when unknown.
   */
  address?: string;
  /**
   * The person switched this account off: it stays linked but is not synced. Only set by a
   * `listAccounts({ includeDisabled: true })`; every other listing leaves such an account out.
   */
  disabled?: boolean;
}

export interface ListAccountsOptions {
  /** Also list switched-off accounts, each marked `disabled`. For the Accounts page only. */
  includeDisabled?: boolean;
}

/** Apply the context's switched-off accounts to a backend's full list. */
export function visibleAccounts(
  context: Pick<BackendContext, 'disabledAccounts'>,
  accounts: BackendAccount[],
  options: ListAccountsOptions = {},
): BackendAccount[] {
  const off = new Set(context.disabledAccounts ?? []);
  if (off.size === 0) return accounts;
  if (!options.includeDisabled) return accounts.filter((a) => !off.has(a.id));
  return accounts.map((a) => (off.has(a.id) ? { ...a, disabled: true } : a));
}

/**
 * The network-neutral port every backend implements, built-in mail included.
 *
 * Small on purpose: what is common to every network is who it is (the manifest) and which
 * accounts it has. Everything about fetching belongs to the sync driver, selected by `kind`.
 */
export interface MessageBackend {
  readonly manifest: BackendManifest;
  /** Which sync driver this backend implements. The engine switches on it, never on the name. */
  readonly kind: string;
  /**
   * The accounts to sync and send from. An account the person switched off (see
   * `BackendContext.disabledAccounts`) is left out, so no consumer — sync, daemon, send — can
   * forget to skip it; the Accounts page asks with `includeDisabled` to show it.
   */
  listAccounts(options?: ListAccountsOptions): Promise<BackendAccount[]>;
  /**
   * Add an account interactively — for networks whose accounts live in curlew rather than in
   * the desktop (mail does too, besides the system accounts it reads). The
   * backend asks through `prompter` for whatever its login needs, and stores the resulting
   * session itself. Resolves with the new account; nothing secret is in it.
   */
  addAccount?(prompter: AccountPrompter, options?: AccountAddOptions): Promise<BackendAccount>;
  /**
   * Open a handle for fetching received attachments, when the manifest claims
   * `capabilities.attachmentsRead`. Optional: a backend without it cannot fetch attachments.
   */
  openAttachments?(accountId: string): Promise<AttachmentFetcher>;
  /**
   * Open a handle for fetching profile pictures, when the manifest claims `capabilities.avatars`.
   * Optional: without it the window shows initials.
   */
  openAvatars?(accountId: string): Promise<AvatarSource>;
  /**
   * Unlink an account from this machine: delete the stored login or session. The messages already
   * indexed stay, and the account stays linked on the service's side — the person unlinks the
   * device there. Optional: a system account (GNOME Online Accounts) is removed by the system, not by us.
   */
  removeAccount?(accountId: string): Promise<void>;
}

/** Flags of `accounts add` that a backend may honour; the others ignore them. */
export interface AccountAddOptions {
  /** Ask for the user's own API credentials even when the build embeds a pair (Telegram). */
  ownCredentials?: boolean;
}

/** How a backend asks the user for login input, whatever the frontend is. */
export interface AccountPrompter {
  /** Ask for one value. `secret` input is not echoed and never logged. */
  ask(label: string, options?: { secret?: boolean }): Promise<string>;
  /** Progress to show the user. Never carries a secret. */
  notify(message: string): void;
  /**
   * Show a linking QR code. The payload is the credential: whoever scans it owns the linked
   * device, so an implementation shows it and never stores or logs it. Optional: a prompter
   * without it (the terminal) gets the code rendered as text through `notify` instead, which is
   * what `notifyQr` does.
   */
  showQr?(data: string, instructions: string): void;
}

/** Show a QR code the best way this prompter can: as an image when it can, else as text. */
export function notifyQr(
  prompter: AccountPrompter,
  data: string,
  instructions: string,
  renderText: (data: string) => string,
): void {
  if (prompter.showQr) prompter.showQr(data, instructions);
  else prompter.notify(`${renderText(data)}\n${instructions}`);
}

/** The mailbox sync driver: folders, UIDs and flags, driven by `syncIndex` in `@curlew/store`. */
export interface MailBackend extends MessageBackend {
  readonly kind: 'mailbox';
  connect(accountId: string): Promise<BackendSession>;
}

/** Narrow a registry entry to the mailbox driver. */
export function isMailBackend(backend: MessageBackend): backend is MailBackend {
  return backend.kind === 'mailbox';
}

// ── construction ────────────────────────────────────────────────────────

/**
 * What the registry hands a backend when it constructs one. Everything a backend may know about
 * its surroundings comes through here, so a backend never reads the config file or picks a
 * directory on its own — and a test can construct one against a temporary directory.
 */
export interface BackendContext {
  /**
   * The backend's own block from the config (`backends.<name>.settings`), as written. The
   * backend validates what it reads: only it knows what its settings mean.
   */
  settings: Readonly<Record<string, string | number | boolean>>;
  /** The process environment, for values a user keeps out of the config file. */
  env: Readonly<Record<string, string | undefined>>;
  /**
   * A private directory (mode 0700) for this backend's secret state — session keys, crypto
   * stores. Separate from the index: the index is rebuildable, this is not, and a backup
   * treats the two differently (`secret` vs `derived`).
   */
  secretsDir: string;
  /**
   * Ids of this backend's accounts the person switched off (`config.disabledAccounts`). Absent
   * means none. A backend applies it in `listAccounts` through `visibleAccounts`.
   */
  disabledAccounts?: readonly string[];
}

// ── the chat driver ─────────────────────────────────────────────────────

/** One person, bot or channel as a chat network reports it. */
export interface ChatPeer {
  /** The network's id for this peer, unique within the account. Opaque to curlew. */
  remoteId: string;
  displayName: string | null;
  /** Every address the network knows for this peer, already normalized (`normalizeAddress`). */
  addresses: ParticipantAddress[];
  /** The network marks this peer as a bot. */
  bot: boolean;
}

/** One chat (a dialog): a direct chat, a group, or a one-way broadcast channel. */
export interface ChatInfo {
  remoteId: string;
  kind: 'direct' | 'group' | 'broadcast';
  title: string | null;
  /** The peers known to be in it, the user excluded — for a direct chat, the other person. */
  members: ChatPeer[];
  /** Sequence number of the newest message, or null for an empty chat. */
  lastSeq: number | null;
  /** Everything at or below this sequence has been read by the user (null: unknown). */
  readInboxSeq: number | null;
  /** Everything the user sent at or below this sequence has been read by the other side. */
  readOutboxSeq: number | null;
  /**
   * The archive's opaque id of the newest entry, for networks that page their archive by id
   * rather than by a number (XMPP MAM). When present — null for an empty chat — the engine
   * decides "caught up" by comparing it with the cursor it stored, not by `lastSeq`.
   */
  lastCursor?: string | null;
  /**
   * What a room-based network reports about the room itself. Every field is null when the network
   * did not say: a reader must not guess "public" or "not encrypted" from silence.
   */
  room?: ChatRoomFacts;
  /**
   * XMPP, direct chats: which of the XEPs in `XMPP_PEER_FEATURES` the peer advertised. Absent when
   * the peer was not asked or did not answer (unknown, not "none").
   */
  peerFeatures?: string[];
}

/** The room facts a window shows next to a composer; null = unknown. */
export interface ChatRoomFacts {
  /** Anyone may join (Matrix `join_rule: public`). */
  public: boolean | null;
  /** End-to-end encrypted (Matrix `m.room.encryption` state present). */
  encrypted: boolean | null;
  /** Joined members, the user included. */
  memberCount: number | null;
}

/** What kind of attachment a chat message carries. */
export type AttachmentKind = 'image' | 'video' | 'audio' | 'voice' | 'file';

/** One attachment on a chat message. */
export interface ChatAttachment {
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  /** What the UI should show it as — the MIME type, or the network's own label (voice note). */
  kind: AttachmentKind;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /**
   * Opaque to everyone but the backend that wrote it: a backend-private JSON string that lets the
   * backend fetch the bytes later. Never leaves `@curlew/store`.
   */
  handle: string;
}

/** One message in a chat. */
export interface ChatMessage {
  /** The network's message id, opaque to curlew and unique within the account. */
  remoteId: string;
  /** Monotonic within its chat: the sync cursor. */
  seq: number;
  sentAt: string | null;
  editedAt: string | null;
  /** Null when the sender is the user (`fromSelf`) or not disclosed by the network. */
  sender: ChatPeer | null;
  fromSelf: boolean;
  text: string | null;
  hasAttachments: boolean;
  /** Attachment metadata for the window; the bytes stay on the network until fetched. */
  attachments?: ChatAttachment[];
  replyToRemoteId: string | null;
  /**
   * The id the reply names, exactly as its sender wrote it (XMPP's `<reply id>`), when the
   * network exposes it. Unlike `replyToRemoteId` it is not resolved to an archive id, so it
   * matches the id a message was SENT with.
   */
  replyToClientId?: string | null;
  /** The thread or forum topic, when the network has them. */
  threadRemoteId: string | null;
  /**
   * What ties the messages of one album together (Telegram's grouped id): consecutive messages of
   * one sender that share it are shown as one block. Absent when the network has no such thing.
   */
  groupId?: string | null;
  /**
   * The id the SENDER gave the message (XMPP's origin-id), when the network exposes it. The
   * engine uses it to recognise the archive's copy of a message curlew itself sent and to drop
   * the local one written at send time.
   */
  clientId?: string | null;
  /**
   * A notice rather than a message: something the network reported about the chat that nobody
   * wrote (a contact's safety number changed). Stored with presentation `notice`, never unread;
   * `text` is what it says. Absent (or false) for everything people wrote.
   */
  notice?: boolean;
}

/** One page of history. */
export interface ChatHistoryPage {
  /** The messages people wrote, oldest first — service notices (joins, pins) left out. */
  messages: ChatMessage[];
  /**
   * The highest sequence the page covered, service notices included — the next cursor. Null
   * when the page was empty.
   */
  highestSeq: number | null;
  /** The lowest sequence the page covered, service notices included. Null when empty. */
  lowestSeq: number | null;
  /** True when nothing newer exists: the chat is caught up. */
  exhausted: boolean;
  /**
   * True when nothing OLDER exists either: the page reaches back to the chat's first message.
   * Together with `lowestSeq`/`highestSeq` this says which range the page covers completely —
   * the range in which a stored message the page does not contain was deleted on the server.
   */
  reachedStart: boolean;
  /**
   * The archive's opaque id of the newest entry the page covered (the one `highestSeq` names),
   * for networks that page by id. Stored with the cursor and handed back as `afterCursor`.
   */
  highestCursor?: string | null;
  /** Earlier messages this page corrects (the network's edit message), by their remote id. */
  edits?: ChatEdit[];
  /**
   * Earlier messages this page retracts or a moderator removed, by remote id: they leave the
   * index. A message retracted inside the same page is simply not in `messages`.
   */
  retracted?: string[];
  /** Reactions this page brings to messages in the chat, stored or in the page. Applied in order. */
  reactions?: ChatReaction[];
  /** Reactions taken back, by the `eventId` they were stored with (Matrix redacts the annotation). */
  retractedReactions?: string[];
}

/** One person's reaction to a message of an archive network. */
export interface ChatReaction {
  /** The message reacted to, by remote id. Dropped when the message is not stored. */
  remoteId: string;
  /** The reacting peer's `remoteId`, or null for the user. */
  reactor: string | null;
  /** Null only with `replace`: the person's set of reactions to the message is now empty. */
  emoji: string | null;
  /** The network's id of the reaction itself, kept when it can be taken back by that id. */
  eventId?: string;
  /**
   * The person's earlier reactions to this message are dropped first: a network that publishes
   * the whole set at once (XMPP) puts this on the first reaction of the set.
   */
  replace?: boolean;
  /**
   * Every reaction to the message is dropped first, whoever left it: a network that reports only
   * the current state of the message (Telegram's counts) puts this on the first reaction of it.
   */
  replaceAll?: boolean;
}

/** A correction of a message synced earlier: its new text replaces the stored one. */
export interface ChatEdit {
  remoteId: string;
  text: string | null;
  editedAt: string | null;
  /**
   * Who made the edit, for networks where an edit is an event anyone could send (Matrix
   * `m.replace`): the peer's `remoteId`, or null for the user. When set, the stored message only
   * changes if it has that sender — someone else's "edit" of your message is not one. Left out
   * (undefined) by networks that already bind a correction to its author (XMPP).
   */
  senderRemoteId?: string | null;
}

/** One connected chat account. Closed by the engine when it is done. */
export interface ChatSession {
  /** Every chat of the account, most recently active first. */
  listChats(): Promise<ChatInfo[]>;
  /**
   * History of one chat.
   *
   * With `afterSeq` null: the newest `limit` messages — the first sync of a chat takes a window,
   * not its whole past. With a number: the oldest `limit` messages strictly newer than it, so
   * repeated calls walk forward without a gap. Implementations must never return a message at
   * or below `afterSeq`.
   *
   * `afterCursor` is the `highestCursor` of the page that ended at `afterSeq`, for networks that
   * page their archive by id; the others ignore it.
   */
  fetchHistory(
    chatRemoteId: string,
    afterSeq: number | null,
    limit: number,
    afterCursor?: string | null,
  ): Promise<ChatHistoryPage>;
  /**
   * Changes to messages stored by EARLIER runs that this run learned about outside any history
   * page — e.g. an encrypted message whose key arrived only now. Optional; called once per run,
   * after every chat was fetched, so it also reaches chats with nothing new.
   */
  revisions?(): Promise<ChatRevision[]>;
  /**
   * Which of these stored messages the network no longer has, by remote id (ADR 0004).
   *
   * The engine asks — it owns the index and so picks the ids — and the backend decides how to
   * ask the network. Only for networks that can be asked about a message BY ID; one that cannot
   * has no such method, and the engine then relies on the re-read window alone.
   *
   * Answer with an id only for one the server POSITIVELY reported gone. An answer that failed,
   * was cut short, or came back shorter than asked says nothing about the ids it left out: those
   * must not be in the result. A false "deleted" destroys index data; a false negative costs one
   * request on the next run.
   */
  probeRetracted?(chatRemoteId: string, remoteIds: readonly string[]): Promise<string[]>;
  /**
   * True when `fetchHistory(chat, afterSeq, n)` can start at ANY stored seq, without a cursor the
   * network handed out earlier. The engine then walks old messages again to describe the
   * attachments the index did not keep when they were first synced (ADR 0010).
   */
  readonly rewindable?: boolean;
  /**
   * True when its messages can carry a `groupId` (an album). The engine then also walks messages
   * that already have descriptors, once, to fill the album in for what was stored before.
   */
  readonly groupsMedia?: boolean;
  close(): Promise<void>;
}

/** Edits and deletions of one chat's stored messages, outside a history page. */
export interface ChatRevision {
  chatRemoteId: string;
  edits?: ChatEdit[];
  /** Stored messages that leave the index, by remote id — like `ChatHistoryPage.retracted`. */
  retracted?: string[];
}

/** What a connection may do beyond reading the archive — one field per grant that widens it. */
export interface ChatConnectOptions {
  /**
   * The backend may decrypt what it syncs and publish whatever keys that takes. Every frontend
   * passes it for every account (ADR 0009 §9; reading bodies is gated per contact).
   *
   * Absent or false, the connection reads the archive exactly as before and encrypted messages
   * are indexed without text.
   */
  decrypt?: boolean;
  /**
   * The addresses this account may never reach in the clear (`encryption: "required"`), bare and
   * already resolved by the frontend that read the config.
   *
   * A peer named here is refused when it has no usable OMEMO device, instead of being answered
   * in plaintext. Like `decrypt`, the decision belongs to the frontend; a backend never reads
   * the config itself.
   */
  requireEncryption?: readonly string[];
}

/** The chat sync driver: dialogs and per-chat sequences, driven by `syncChats` in `@curlew/store`. */
export interface ChatBackend extends MessageBackend {
  readonly kind: 'chat';
  connect(accountId: string, options?: ChatConnectOptions): Promise<ChatSession>;
}

/** Narrow a registry entry to the chat driver. */
export function isChatBackend(backend: MessageBackend): backend is ChatBackend {
  return backend.kind === 'chat';
}

/** Narrow a registry entry to one that can fetch attachments. */
export function isAttachmentFetcherBackend(
  backend: MessageBackend,
): backend is MessageBackend & { openAttachments: NonNullable<MessageBackend['openAttachments']> } {
  return typeof backend.openAttachments === 'function';
}

/** Narrow a registry entry to one that can unlink an account. */
export function isAccountRemoverBackend(
  backend: MessageBackend,
): backend is MessageBackend & { removeAccount: NonNullable<MessageBackend['removeAccount']> } {
  return typeof backend.removeAccount === 'function';
}

// ── the delivery driver ─────────────────────────────────────────────────

/**
 * One delivery a backend received but could not turn into an event, as the backend kept it.
 *
 * WHO sent it and WHEN is what finds the message on the phone, WHY says what this build could not
 * map, and `bytes` is how big the plaintext was. The content itself is deliberately not here: it
 * stays in the backend's secret file, and a listing is a way to identify a message, not to read it.
 */
export interface SetAsideRecord {
  /** The network's id for the sender, as far as the plaintext named one (a Signal ACI). */
  sender: string;
  /** When they sent it, ISO-8601. */
  sentAt: string;
  /** Why nothing was mapped: a parse error, or fields a newer version of the network added. */
  reason: string;
  /** The size of the kept plaintext in bytes. Its content is never part of this. */
  bytes: number;
}

/** The set-aside ledger of one account, as its backend holds it. */
export interface SetAsideLedger {
  /** What is still kept, oldest first. */
  entries: SetAsideRecord[];
  /**
   * What the listing leaves out besides `entries`: the backend's own bound pushed them out, or it
   * cannot say who sent them and when — either way there is nothing here to find on the phone.
   */
  dropped: number;
}

/**
 * One chat as a delivery-only network describes it. There is no sequence to walk: what the
 * network reports is the chat's identity, and — when it knows them — its members.
 */
export interface DeliveryChat {
  remoteId: string;
  kind: ChatInfo['kind'];
  title: string | null;
  /** The peers known to be in it, the user excluded. Null: this report says nothing about members. */
  members: ChatPeer[] | null;
}

/**
 * One thing that happened, as a delivery-only network pushes it. A delivery session turns the
 * network's own events into these, so the store engine applies them without naming a network.
 *
 * Every event names its chat by `chatRemoteId`; a message may arrive before any `chat` event
 * for its chat (a new chat), which is why it carries the chat's kind itself.
 */
export type DeliveryEvent =
  /** A chat appeared or changed (title, members). */
  | { type: 'chat'; chat: DeliveryChat }
  /** The user read the chat on another device: all but the newest `unreadCount` incoming messages are read. */
  | { type: 'chat-read'; chatRemoteId: string; unreadCount: number }
  /**
   * Two chat ids turned out to be one chat (a network that addresses a person two ways, and
   * told which ids belong together only later): everything stored under `from` moves to
   * `into`. Message remote ids stay as they are. A no-op when nothing is stored under `from`.
   */
  | { type: 'chat-merged'; from: string; into: string }
  /** The user deleted the chat on another device: it goes here too, with its messages. */
  | { type: 'chat-deleted'; chatRemoteId: string }
  /** The user cleared the chat's messages on another device; the chat itself stays. */
  | { type: 'chat-cleared'; chatRemoteId: string }
  /** What the network knows about a person changed (a name, a newly known address). */
  | { type: 'peer'; peer: ChatPeer }
  /**
   * One message. `seq` orders it within its chat (a delivery network has no server sequence,
   * so it is usually the send time). `seen` is whether the user has read it already.
   */
  | {
      type: 'message';
      chatRemoteId: string;
      chatKind: ChatInfo['kind'];
      message: ChatMessage;
      seen: boolean;
    }
  /** A message was edited. Applies to a stored message only; an edit of one never stored is dropped. */
  | { type: 'edit'; chatRemoteId: string; remoteId: string; text: string | null; editedAt: string | null }
  /** A message was deleted (revoked for everyone, or deleted for the user on another device). */
  | { type: 'delete'; chatRemoteId: string; remoteId: string }
  /**
   * Someone reacted to a message with an emoji; a null `emoji` takes the reaction back. A person
   * has one reaction per message, so a new one replaces the old. `reactor` is the network's
   * peer id, or null for the user. Applies to a stored message only (like an edit).
   */
  | { type: 'reaction'; chatRemoteId: string; remoteId: string; reactor: string | null; emoji: string | null }
  /**
   * The other side read these messages of the user.
   *
   * `chatRemoteId` is null when the network does not say which chat it is about: a Signal
   * `ReceiptMessage` names a type and a list of sent timestamps and nothing else
   * (`refs/signal-desktop/protos/SignalService.proto`), so only the remote ids locate the
   * messages, and they are looked up across the account's own messages. A remote id that no
   * stored message carries is dropped.
   */
  | { type: 'peer-read'; chatRemoteId: string | null; remoteIds: string[] };

/**
 * How long a delivery session runs.
 *
 * `catch-up` is `curlew sync`: connect, receive what was queued while nobody listened (and, on
 * a freshly linked device, the history the network hands over once), and end when that is done.
 * `follow` is a daemon: keep receiving until closed. Both go through the same receive path, so a
 * daemon is `catch-up` that does not stop.
 */
export type DeliveryMode = 'catch-up' | 'follow';

export interface DeliveryConnectOptions {
  mode: DeliveryMode;
}

/** How a delivery session ended — reported, never hidden. */
export interface DeliveryOutcome {
  /** True when the session saw the network say its backlog was delivered; false when it gave up waiting. */
  caughtUp: boolean;
  /** A reason the session ended early (the network logged the device out, the connection dropped). */
  error: string | null;
  /**
   * True when the session ended because the network no longer knows this device: it was logged
   * out (Baileys' `DisconnectReason.loggedOut`) or unlinked (libsignal's `DeviceDelinked`).
   *
   * This is the one ending that is NOT worth retrying — the credentials are gone, and every
   * reconnect fails the same way, so a follow-mode caller stops the account on it. A dropped
   * connection is the opposite and leaves this absent: a reconnect may well work.
   */
  loggedOut?: boolean;
  /**
   * Deliveries the session received but could not turn into events, kept raw in the backend's
   * secret state so a later version can map them (a new message type, a parser bug) — received,
   * not lost. Absent: none, or a backend that does not keep them.
   */
  setAside?: number;
  /** Deliveries that could not be decrypted — gone; only their metadata was kept for diagnosis. */
  undecryptable?: number;
  /**
   * Envelopes the session received, acknowledged, and did not turn into events, by reason.
   *
   * On these networks an acknowledgement is the last moment a delivery can be taken back, and a
   * session acknowledges every envelope it processed — including the ones it could not read. So a
   * run that dropped three envelopes and a run that received none are the same report:
   * `added: 0`, no error. This map is what tells them apart, and without it every receiving bug
   * is unfindable after the fact. The keys are the backend's own reason names — a caller counts
   * and shows them, it does not match on them.
   */
  skipped?: Record<string, number>;
}

/** One connected delivery-only account. */
export interface DeliverySession {
  /**
   * The next batch of events, in arrival order. Resolves null when the session is over: in
   * `catch-up` mode once the backlog is delivered, in `follow` mode only after `close`.
   *
   * Delivery is at most once on these networks — the server forgets a message once this device
   * acknowledged it — so the engine writes every batch before asking for the next one, and
   * asking IS the acknowledgement: a session that journals what it received may drop the
   * previous batch from its journal then, and must keep it when the session is closed without
   * another call (the write failed).
   */
  nextBatch(): Promise<DeliveryEvent[] | null>;
  /** How the session ended; meaningful once `nextBatch` resolved null. */
  outcome(): DeliveryOutcome;
  /**
   * Close the session — twice is fine, and callers do: a receiver that is stopped from outside
   * closes on the signal and again when its own loop unwinds. Closing ends the session: what
   * still arrives is drained once, on the way out.
   */
  close(): Promise<void>;
  /**
   * Profile pictures on THIS session's live connection, for a network where a second login would
   * collide with the receiver's (WhatsApp). The daemon asks it when the backend has no
   * `openAvatars` of its own; closing the source never closes the session.
   */
  openAvatars?(): Promise<AvatarSource>;
  /**
   * Send on THIS session's live connection and protocol state (ADR 0004, amendment 2026-10-30,
   * daemon send).
   *
   * A backend whose send writes the same state its receive path writes — `sendSharesReceiveState`
   * — cannot be sent on from a second process while this session is open. Rather than refuse the
   * send, the process holding the session performs it: `curlew daemon` exports this over the
   * session bus, so a CLI or MCP send reaches the connection that is already up.
   *
   * The permit is the caller's, already checked against the grants, and the handle re-checks it
   * exactly as `SendBackend.openSender` does — this is not a way around the fence, only a way to
   * the right connection. The returned handle's `close()` must release ONLY what the send opened:
   * closing a sender must never take this session's connection down with it.
   *
   * Optional: a session without it is one the daemon cannot send on, and the caller falls back to
   * its own direct path.
   */
  openSender?(permit: SendPermit): Promise<MessageSender>;
}

/**
 * The delivery sync driver: for networks without a server archive (WhatsApp, Signal), driven by
 * `receiveDeliveries` in `@curlew/store`. What it writes is the only copy (`state`).
 */
export interface DeliveryBackend extends MessageBackend {
  readonly kind: 'delivery';
  connect(accountId: string, options: DeliveryConnectOptions): Promise<DeliverySession>;
  /**
   * Read back the plaintexts this backend kept because it could not map them — what
   * `DeliveryOutcome.setAside` only ever counts, per run. So the user can look those messages up
   * on the phone (sender and time) or report a decoder bug (reason and size).
   *
   * Optional: a backend that keeps no such ledger has no such method, and a caller reads an empty
   * ledger rather than an error. An implementation must not answer with the plaintext itself.
   */
  setAsideLedger?(accountId: string): Promise<SetAsideLedger>;
}

/** Narrow a registry entry to the delivery driver. */
export function isDeliveryBackend(backend: MessageBackend): backend is DeliveryBackend {
  return backend.kind === 'delivery';
}

// ── the attachment fetch port ───────────────────────────────────────────

/** Which account an attachment fetch is for. */
export interface AccountRef {
  backend: string;
  accountId: string;
}

/** What a fetch needs from the stored attachment row; the handle is opaque to the caller. */
export interface FetchableAttachment {
  kind: AttachmentKind;
  handle: string;
}

/** Where the backend writes the bytes it fetches. */
export interface ByteSink {
  write(chunk: Uint8Array): Promise<void> | void;
  close(): Promise<void> | void;
}

/**
 * Optional handle a backend exposes when its manifest claims `attachmentsRead`.
 *
 * Fetches are always the person's own action or a small picture that scrolled into view; the
 * backend verifies the bytes before the sink sees the last one and throws on mismatch.
 */
export interface AttachmentFetcher {
  fetchAttachment(
    account: AccountRef,
    attachment: FetchableAttachment,
    sink: ByteSink,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<{ mimeType: string | null; size: number }>;
}

/**
 * Profile pictures behind ONE connection, so a screenful of rows costs one connect and not one
 * per row. `peer` is the chat's address as the index holds it (`ListEntry.target`).
 */
export interface AvatarSource {
  /** The small picture of `peer` into `sink`, or null when the peer has none (or it is not visible to us). */
  fetchAvatar(
    peer: string,
    sink: ByteSink,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<{ mimeType: string | null; size: number } | null>;
  /** Release the connection. */
  close(): Promise<void>;
}

// ── the send port ───────────────────────────────────────────────────────

/**
 * What the grants allow for ONE account: the exact addresses `<backend>.send` names for it.
 *
 * Built by the frontend that checked the grant (ADR 0004) and handed to `openSender`; a backend
 * never reads the grant set itself, and the handle re-checks every address against this, so a
 * bug above cannot widen what a grant allowed.
 */
export interface SendPermit {
  account: string;
  addresses: readonly string[];
}

/** What one sender may do beyond a plain-text body. A manifest describes the backend; this the handle. */
export interface SenderFeatures {
  /** The text is chat Markdown, rendered per protocol and split at the protocol's limit (XMPP's XEP-0393). */
  markdown: boolean;
  /** The sender can attach files (`SendingMessage.attachments`); one that cannot is never handed any. */
  attachments: boolean;
  /**
   * The sender can answer one message (`SendingMessage.replyTo`); one that cannot is never handed a
   * target, and a frontend hides its reply entry. Mail threads through `inReplyTo` instead.
   */
  replies: boolean;
  /**
   * The sender can react to one message (`MessageSender.react`); one that cannot is never asked to,
   * and a frontend hides its emoji row.
   */
  reactions: boolean;
  /**
   * The sender can edit one of the person's own messages (`MessageSender.edit`); one that cannot is
   * never asked to, and a frontend hides its edit entry.
   */
  edits: boolean;
  /**
   * The sender can delete one of the person's own messages (`MessageSender.delete`); one that cannot
   * is never asked to, and a frontend hides its delete entry.
   */
  deletes: boolean;
  /**
   * The sender can confirm that the person read a message (`MessageSender.readReceipt`); one that
   * cannot is never asked to. Absent means false.
   */
  readReceipts?: boolean;
}

/** A file to send with a message, by absolute path. Only the sender that claims `attachments` reads it. */
export interface SendingAttachment {
  path: string;
}

/** The message a reply answers. Grows with the protocols that need more than the id. */
export interface ReplyTarget {
  /** The network's id of the message, as the index holds it (`ChatMessage.remoteId`). */
  remoteId: string;
  /**
   * The id its sender gave it (`ChatMessage.clientId`), for a network whose reply names that
   * rather than the archive's id (XMPP). Absent when the index does not hold one.
   */
  clientId?: string;
  /** Whether the person wrote the message themselves: the author a reply names (XMPP, WhatsApp). */
  fromSelf?: boolean;
  /** What the message said, for a network whose quote carries the content itself (WhatsApp). */
  text?: string;
  /** Mail only: the message carries `Chat-Version`, so its peer speaks Delta Chat. */
  emailChat?: boolean;
}

/** One message handed to a sender. */
export interface SendingMessage {
  to: string;
  text: string;
  /** Only when the sender's `features.replies` is true (chat): the message this one answers. */
  replyTo?: ReplyTarget;
  /** Only when the backend's manifest claims `capabilities.subject` (mail). */
  subject?: string;
  /** Only when the sender's `features.attachments` is true (mail). */
  attachments?: SendingAttachment[];
  /** Mail from the chat UI: add `Chat-Version: 1.0` and optionally answer an existing message. */
  emailChat?: boolean;
  /** With `emailChat`: the one attachment is a voice note (`Chat-Voice-Message`), `durationMs` its length. */
  voiceMessage?: boolean;
  durationMs?: number;
  /** With `emailChat`: the one attachment is a sticker (`Chat-Content: sticker`). */
  sticker?: boolean;
  inReplyTo?: string;
  references?: string[];
  /**
   * Mail from a Delta Chat thread: ask the peer for a read receipt (`Chat-Disposition-Notification-To`).
   * Set only when the person allowed read receipts and the thread can do them.
   */
  readReceipt?: boolean;
}

/** One reaction handed to a sender: the person's emoji on a message of the chat `to`. */
export interface SendingReaction {
  to: string;
  /** The message reacted to; its `fromSelf` names the author for networks that need it (WhatsApp). */
  target: ReplyTarget;
  /** What the person now reacts with, replacing an earlier reaction of theirs; null takes it back. */
  emoji: string | null;
  /**
   * With `emoji: null`: the emoji being taken back. Signal names it on the wire and drops a removal
   * without one; networks that remove by author ignore it.
   */
  previous?: string;
}

/** One edit handed to a sender: the person's new text for one of their own messages in the chat `to`. */
export interface SendingEdit {
  to: string;
  /** The message being edited; it must be the person's own (`fromSelf: true`). */
  target: ReplyTarget;
  /** The new text for the message. */
  text: string;
}

/** One deletion handed to a sender: the person's own message in the chat `to`. */
export interface SendingDeletion {
  to: string;
  /** The message being deleted; it must be the person's own (`fromSelf: true`). */
  target: ReplyTarget;
}

/** One read receipt handed to a sender: the person read `target`, a message of the chat `to`. */
export interface SendingReadReceipt {
  /** Where the receipt goes: the address that asked for it (`Chat-Disposition-Notification-To`). */
  to: string;
  /** The message that was read. */
  target: ReplyTarget;
}

/** What a send returned. `id` is the network's own id and what the write log records (ADR 0004 §7). */
export interface SentMessage {
  /** The address it went to, exactly as the permit spelled it. */
  target: string;
  id: string;
  sentAt: string;
  /**
   * The chat the message belongs to, for a backend whose archive the index holds (XMPP's bare
   * JID). Absent for mail, whose sent copy is filed in the Sent mailbox and indexed by the next sync.
   */
  chatRemoteId?: string;
  /** Whether it left end-to-end encrypted. Absent where the network has no such thing. */
  encrypted?: boolean;
  /**
   * The message WAS delivered, but something around it was not done — a sender sets this instead
   * of throwing where a throw would make a retry send the message twice (Signal: the recipient has
   * it, the user's own other devices were not told). One sentence for the user, never a stack.
   */
  warning?: string;
  /** The files that went out, by name and size — never their content. What the write log records. */
  attachments?: Array<{ filename: string; size: number }>;
  /**
   * The same files as the index stores them, for a backend whose network does not hand the sent
   * message back to this device (Signal): the local echo then carries them, so the chat shows
   * what was sent. Only with a handle that can fetch the bytes again.
   */
  echoAttachments?: ChatAttachment[];
}

/**
 * The handle that may write — opened only with a permit from a grant (ADR 0004 §5), in the same
 * pattern as Signal's `guardedFetch`. The sync handle has no method that sends and no way to
 * obtain one: `MessageSender` is reachable only through `SendBackend.openSender`.
 */
export interface MessageSender {
  readonly features: SenderFeatures;
  send(message: SendingMessage): Promise<SentMessage>;
  /** One image by https URL, as its own message; absent when the backend does not send images. */
  sendImage?(to: string, url: string): Promise<SentMessage>;
  /** Present exactly when `features.reactions` is true. */
  react?(reaction: SendingReaction): Promise<void>;
  /** Present exactly when `features.edits` is true. */
  edit?(edit: SendingEdit): Promise<void>;
  /** Present exactly when `features.deletes` is true. */
  delete?(deletion: SendingDeletion): Promise<void>;
  /** Present exactly when `features.readReceipts` is true. */
  readReceipt?(receipt: SendingReadReceipt): Promise<void>;
  close(): Promise<void>;
}

/**
 * A backend that can send. The caller has already resolved the account and checked the
 * `<backend>.send` grant; `options` carries the decisions the frontend read from the config
 * (decryption, required encryption) so a backend never reads it itself.
 */
export interface SendBackend extends MessageBackend {
  openSender(accountId: string, permit: SendPermit, options?: ChatConnectOptions): Promise<MessageSender>;
  /**
   * Whether `to` is an address of this account itself — the person's own number, JID, mail
   * address or note-to-self chat, in every spelling the network gives it (ADR 0008). A message
   * there reaches nobody else, so an agent needs no grant for it.
   *
   * Only POSITIVE knowledge counts: a backend answers true when it can tell from what it already
   * stores about its own account, and false for everything else — a lookalike, an unknown form, a
   * session it cannot read. Leaving the method out means "cannot tell", which is false.
   */
  isSelfAddress?(accountId: string, to: string): Promise<boolean>;
}

/** Narrow a registry entry to the send port. */
export function isSendBackend(backend: MessageBackend): backend is SendBackend {
  return typeof (backend as Partial<SendBackend>).openSender === 'function';
}
