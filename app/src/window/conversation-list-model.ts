/**
 * The combined conversation list: what is shown and in which order, with no widget in sight.
 *
 * One list across every messenger, organised by function (docs/design/ui.md): people and groups
 * as sections, protocol and account as filters. A conversation is asked what it IS (`kind`), never
 * "is this Signal?"; the backend name only picks the badge and the filter chip.
 */

import type { AddressKind, Conversation } from '@curlew/protocol';
import { _, _n, fmt } from '@curlew/protocol';

export type SectionId = 'people' | 'groups';

/** A conversation reduced to what a row needs. */
export interface ListEntry {
  id: string;
  /** Canonical threads behind this row; several for a direct-mail contact conversation. */
  conversationIds: string[];
  title: string;
  backend: string;
  accountId: string;
  kind: Conversation['kind'];
  unread: number;
  lastMessageAt: string | null;
  /** Address the composer answers: the other person, or for a Matrix room its room id. */
  target: string | null;
  emailChat: boolean;
  /** What the index knows about the room behind a Matrix chat; null for every other backend. */
  room: RoomFacts | null;
  /**
   * For merged rows only: the child rows this presentation combines. A merged "Note to self"
   * carries every self-chat backend here; non-merged rows keep an empty array.
   */
  members: ListEntry[];
  /**
   * The directory participants this row stands for: one for a direct chat with one other person,
   * every person of a merged row, none for a group or a note to self.
   */
  personIds: string[];
  /** True when the person joined people the address book does not own together (a manual merge). */
  manual: boolean;
  /**
   * The backend the person pinned this merged row to, or null for automatic routing. Only a row
   * that joins several chats can be pinned; the composer, the picker and agents follow it.
   */
  pin: string | null;
  /**
   * The line under the title: the newest message, ready to show. Absent until the window has read
   * it from the index; it is never part of `Conversation`, so agents do not get it.
   */
  preview?: string;
}

/**
 * Groups of people the person merged by hand, each a list of participant ids. Local to this
 * machine; the address book is never written.
 */
export type PersonMerges = ReadonlyArray<ReadonlyArray<string>>;

/** Participant id to the backend that person is pinned to. Local to this machine. */
export type PersonPins = Readonly<Record<string, string>>;

/** One carrier the composer can send a merged row through. */
export interface ProtocolChoice {
  backend: string;
  accountId: string;
  /** The address or room id the selected protocol sends to. */
  target: string;
  label: string;
  icon: string;
}

/** The room facts the window uses (`listChatRooms`); `null` fields are unknown, never "no". */
export interface RoomFacts {
  chatId: string;
  public: boolean | null;
  encrypted: boolean | null;
  memberCount: number | null;
}

export interface Section {
  id: SectionId;
  title: string;
  entries: ListEntry[];
  /** Unread conversations in the section, shown on the header while it is collapsed. */
  unread: number;
}

export interface ListFilter {
  /** Empty = every protocol. */
  backends: ReadonlySet<string>;
  /**
   * Chosen accounts per protocol. A protocol with no choice shows every account; a choice narrows
   * only inside its own protocol, and counts only while that protocol is chosen.
   */
  accounts: ReadonlyMap<string, ReadonlySet<string>>;
  query: string;
  /**
   * Conversation id → a line of message text that contains the query. A conversation in here
   * passes the query even when its title does not, and its row shows the line.
   */
  hits?: ReadonlyMap<string, string>;
}

/** Shorter queries are matched against titles only: one letter would hit nearly every message. */
export const MIN_TEXT_QUERY = 2;

export const NO_FILTER: ListFilter = { backends: new Set(), accounts: new Map(), query: '' };

const PROTOCOLS: Record<string, { label: () => string; icon: string }> = {
  mail: { label: () => _('Mail'), icon: 'mail-unread-symbolic' },
  xmpp: { label: () => _('XMPP'), icon: 'network-server-symbolic' },
  signal: { label: () => _('Signal'), icon: 'security-high-symbolic' },
  matrix: { label: () => _('Matrix'), icon: 'network-workgroup-symbolic' },
  telegram: { label: () => _('Telegram'), icon: 'send-to-symbolic' },
  whatsapp: { label: () => _('WhatsApp'), icon: 'call-start-symbolic' },
};

const FALLBACK_ICON = 'network-transmit-receive-symbolic';

/** The name a person knows the protocol by; an unknown backend shows its own name. */
export function protocolLabel(backend: string): string {
  return PROTOCOLS[backend]?.label() ?? backend;
}

/**
 * A neutral themed symbolic icon: the protocols' own logos are trademarks with their own licences,
 * so each badge is a distinct symbol (envelope, server, shield, globe, paper plane, phone) and the
 * tooltip names the protocol.
 */
export function protocolIcon(backend: string): string {
  return PROTOCOLS[backend]?.icon ?? FALLBACK_ICON;
}

/**
 * A short time for the title line: `14:05` today, "Yesterday", else the ISO date. Locale-neutral
 * on purpose, so a German and an English window agree except for the one word.
 */
export function shortTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const two = (n: number) => String(n).padStart(2, '0');
  const day = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  if (day(at) === day(now)) return `${two(at.getHours())}:${two(at.getMinutes())}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return day(at) === day(yesterday) ? _('Yesterday') : day(at);
}

/**
 * The account's own address when this conversation is the one the person writes to themselves
 * ("Note to self"), else null. Positive knowledge only, from what the index stores: a backend that
 * cannot tell from it answers null and the chat stays an ordinary one.
 *
 * - Signal: the chat with the account's own ACI is a direct chat with nobody else in it, and the
 *   ACI is the account id's suffix.
 * - XMPP, Matrix: the only participant carries the account's own JID / user id (`identity`).
 * - Telegram: Saved Messages is the chat with the own user id, which is the account id's suffix.
 * - WhatsApp: the account's own JIDs (`accounts.address`, written at sync time from the linked
 *   device's credentials; the account id is a registration id and the identity a display name, so
 *   neither helps). A direct chat whose only participant carries one of them. Without a stored
 *   JID the chat stays an ordinary one.
 */
export function selfAddressOf(conversation: Conversation, identity?: string): string | null {
  if (conversation.kind !== 'direct') return null;
  const { backend, accountId, participants } = conversation;
  const values = (kind: AddressKind): string[] =>
    participants.flatMap((p) => p.addresses.filter((a) => a.kind === kind).map((a) => a.value));
  switch (backend) {
    case 'signal': {
      const aci = /^signal-(.+)$/.exec(accountId)?.[1];
      return aci !== undefined && participants.length === 0 ? aci : null;
    }
    case 'telegram': {
      const id = /^telegram-(\d+)$/.exec(accountId)?.[1];
      return id !== undefined && participants.length === 1 && values('telegram').includes(id) ? id : null;
    }
    case 'whatsapp': {
      const own = ownJids(identity);
      if (own.size === 0 || participants.length !== 1) return null;
      const jids = values('whatsapp');
      return jids.some((v) => own.has(bareLower(v))) ? jids[0] : null;
    }
    case 'xmpp':
    case 'matrix': {
      const own = identity?.trim().toLowerCase();
      if (!own || participants.length !== 1) return null;
      const kind = backend === 'xmpp' ? 'jid' : 'matrix';
      return values(kind).some((v) => v.trim().toLowerCase() === own) ? identity!.trim() : null;
    }
    default:
      return null;
  }
}

/** `user@server`, lowercase, without a device suffix — how both the index and the account row spell a JID. */
function bareLower(jid: string): string {
  return jid
    .trim()
    .toLowerCase()
    .replace(/^([^@:\s]+):\d+@/, '$1@');
}

/** The user JIDs in a WhatsApp account's `address` (space-separated); a display name yields none. */
function ownJids(address: string | undefined): Set<string> {
  const jids = (address ?? '')
    .split(/\s+/)
    .map(bareLower)
    .filter((v) => /^\d+@(s\.whatsapp\.net|lid)$/.test(v));
  return new Set(jids);
}

/** The title a row shows: the stored one, else the people in it, else the first address. */
export function entryTitle(conversation: Conversation, identity?: string): string {
  if (selfAddressOf(conversation, identity) !== null) return _('Note to self');
  const names = conversation.participants
    .map((p) => p.displayName?.trim() || p.addresses[0]?.value || '')
    .filter((name) => name !== '');
  // A direct chat is a person, not its first mail subject. Groups keep their stored topic.
  if (conversation.kind === 'direct' && names.length > 0) return names.join(', ');
  const stored = conversation.title?.trim();
  if (stored) return stored;
  // A Signal member without a profile name is only an opaque ID; a list of those says nothing.
  const opaque = conversation.participants.filter(
    (p) => !p.displayName?.trim() && p.addresses[0]?.kind === 'signal',
  );
  if (conversation.kind === 'group' && opaque.length > 0) {
    const named = conversation.participants.length - opaque.length;
    if (named > 0)
      return conversation.participants
        .flatMap((p) => (p.displayName?.trim() ? [p.displayName.trim()] : []))
        .join(', ');
    return fmt(_n('Unnamed group · {count} member', 'Unnamed group · {count} members', opaque.length), {
      count: opaque.length,
    });
  }
  return names.length > 0 ? names.join(', ') : _('Unnamed conversation');
}

// The address kind each backend sends to. A participant often carries addresses of several
// networks (a phone number first), and only the backend's own kind names the chat it can send to.
const SEND_KIND: Readonly<Record<string, AddressKind>> = {
  mail: 'email',
  signal: 'signal',
  telegram: 'telegram',
  whatsapp: 'whatsapp',
  matrix: 'matrix',
  xmpp: 'jid',
};

/**
 * The address the composer sends to. A Matrix message goes to a ROOM, so its target is the room id
 * the index holds as the chat's remote id (the form the send path's permit names) — for a direct
 * chat and a group alike, and null while the index has no room row for it. Every other backend
 * answers only a direct chat, by the other person's address.
 */
export function targetOf(conversation: Conversation, room: RoomFacts | null = null): string | null {
  if (conversation.backend === 'matrix') return room?.chatId ?? null;
  if (conversation.kind !== 'direct' || conversation.participants.length !== 1) return null;
  const kind = SEND_KIND[conversation.backend];
  if (kind === undefined) return null;
  return conversation.participants[0].addresses.find((address) => address.kind === kind)?.value ?? null;
}

/** `identities`: account id → the address the account is known by, as the index stores it. */
export function toEntry(
  conversation: Conversation,
  identity?: string,
  room: RoomFacts | null = null,
): ListEntry {
  return {
    id: conversation.id,
    conversationIds: [conversation.id],
    title: entryTitle(conversation, identity),
    backend: conversation.backend,
    accountId: conversation.accountId,
    kind: conversation.kind,
    unread: Math.max(0, conversation.unreadCount),
    lastMessageAt: conversation.lastMessageAt,
    target:
      conversation.backend === 'matrix'
        ? targetOf(conversation, room)
        : (selfAddressOf(conversation, identity) ?? targetOf(conversation)),
    emailChat: conversation.emailChat,
    room: conversation.backend === 'matrix' ? room : null,
    members: [],
    personIds: personOf(conversation, identity) === null ? [] : [personOf(conversation, identity)!],
    manual: false,
    pin: null,
  };
}

/** The one other person of a direct chat, when the chat is not the note to self. */
function personOf(conversation: Conversation, identity?: string): string | null {
  if (conversation.kind !== 'direct' || conversation.participants.length !== 1) return null;
  if (selfAddressOf(conversation, identity) !== null) return null;
  return conversation.participants[0]!.id;
}

/**
 * Why the composer cannot be used in this conversation, or null when it can. An encrypted Matrix
 * room is the one case: curlew has no way to encrypt, and a cleartext message there would be
 * readable by the server and defeat what the room's members chose (the send path refuses it too;
 * this only says so before anyone types). Unknown encryption is not a block — the sender asks the
 * homeserver again right before the send.
 */
export function composerBlock(entry: ListEntry): string | null {
  if (entry.pin !== null && protocolChoices(entry).length === 0) {
    return fmt(_('Only via {protocol}, which has no address for this person'), {
      protocol: protocolLabel(entry.pin),
    });
  }
  return entry.room?.encrypted === true ? _('Encrypted rooms are not supported yet') : null;
}

/** True when the composer has at least one carrier it can send through. */
export function canSend(entry: ListEntry): boolean {
  if (entry.pin !== null) return true;
  if (entry.target !== null) return true;
  return entry.members.some((m) => m.target !== null);
}

/** The carriers a merged row can send through; empty for a non-merged row. */
export function protocolChoices(entry: ListEntry): ProtocolChoice[] {
  return entry.members
    .filter((m) => m.target !== null && (entry.pin === null || m.backend === entry.pin))
    .map((m) => ({
      backend: m.backend,
      accountId: m.accountId,
      target: m.target!,
      label: protocolLabel(m.backend),
      icon: protocolIcon(m.backend),
    }));
}

/** The single carrier for a non-merged row, or the only member of a merged one. */
export function singleChoice(entry: ListEntry): ProtocolChoice | null {
  if (entry.pin !== null) return protocolChoices(entry)[0] ?? null;
  const source = entry.members.length === 1 ? entry.members[0]! : entry;
  if (source.target === null) return null;
  return {
    backend: source.backend,
    accountId: source.accountId,
    target: source.target,
    label: protocolLabel(source.backend),
    icon: protocolIcon(source.backend),
  };
}

/** One line of the route menu: "Automatic" (backend null) or one protocol the row can pin to. */
export interface RouteOption {
  backend: string | null;
  label: string;
  active: boolean;
}

/**
 * What the route menu of a merged person offers: automatic routing, then each protocol that has a
 * known address, in label order. Empty for a row that is not a merged person: nothing to pin.
 */
export function routeOptions(entry: ListEntry): RouteOption[] {
  if (entry.members.length < 2 || entry.personIds.length === 0) return [];
  const backends = new Set(entry.members.filter((m) => m.target !== null).map((m) => m.backend));
  if (entry.pin !== null) backends.add(entry.pin);
  const pins = [...backends]
    .map((backend) => ({
      backend,
      label: fmt(_('Only via {protocol}'), { protocol: protocolLabel(backend) }),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((option) => ({ ...option, active: entry.pin === option.backend }));
  return [{ backend: null, label: _('Automatic'), active: entry.pin === null }, ...pins];
}

/**
 * The subtitle under a merged "Note to self" header: the protocols it can send through, each once,
 * in a fixed order. An ordinary row keeps the single protocol label.
 */
export function entryProtocolSubtitle(entry: ListEntry): string {
  if (entry.members.length === 0) return protocolLabel(entry.backend);
  if (entry.pin !== null) return fmt(_('Only via {protocol}'), { protocol: protocolLabel(entry.pin) });
  const labels = [...new Set(entry.members.map((m) => protocolLabel(m.backend)))].sort();
  return labels.join(' · ');
}

/**
 * The subtitle for a list row. Ordinary rows show the account label if there is one, else the
 * protocol name; merged rows show one label per member the same way. The raw account id is never
 * surfaced because it is not text a person reads.
 */
export function listSubtitle(entry: ListEntry, accountLabels: ReadonlyMap<string, string>): string {
  if (entry.members.length === 0) {
    return accountLabels.get(entry.accountId) ?? protocolLabel(entry.backend);
  }
  const labels = [
    ...new Set(entry.members.map((m) => accountLabels.get(m.accountId) ?? protocolLabel(m.backend))),
  ].sort();
  return labels.join(' · ');
}

/** What the store knows about a conversation's newest message; `MessagePreview` fits this. */
export interface PreviewSource {
  sentAt: string | null;
  fromSelf: boolean;
  body: string | null;
  subject: string | null;
  hasAttachments: boolean;
  senderName: string | null;
}

const PREVIEW_CHARS = 120;

const oneLine = (text: string | null): string =>
  (text ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line !== '') ?? '';

/**
 * The preview line of a row: the first non-blank line of the text, else the mail subject, else a
 * note that there is an attachment. Your own messages say "You", a group's say who wrote them.
 */
export function previewText(source: PreviewSource, group: boolean): string {
  let text = oneLine(source.body) || oneLine(source.subject);
  if (text === '' && source.hasAttachments) text = _('Attachment');
  if (text === '') return '';
  if (text.length > PREVIEW_CHARS) text = `${text.slice(0, PREVIEW_CHARS - 1).trimEnd()}…`;
  if (source.fromSelf) return fmt(_('You: {text}'), { text });
  const name = source.senderName?.trim();
  return group && name ? fmt(_('{name}: {text}'), { name, text }) : text;
}

/** The rows with their preview set from the newest message among the conversations each stands for. */
export function withPreviews(
  entries: readonly ListEntry[],
  previews: ReadonlyMap<string, PreviewSource>,
): ListEntry[] {
  return entries.map((entry) => {
    let newest: PreviewSource | null = null;
    for (const id of entry.conversationIds) {
      const candidate = previews.get(id);
      if (candidate && (newest === null || (candidate.sentAt ?? '') > (newest.sentAt ?? '')))
        newest = candidate;
    }
    const text = newest === null ? '' : previewText(newest, entry.kind !== 'direct');
    return text === '' ? entry : { ...entry, preview: text };
  });
}

/**
 * The small line above a Matrix room's composer: "Public room · 12 members". Only for a room
 * that is not a direct chat, and only once the homeserver has said whether it is public and how
 * many are in it — an unknown is left out, not guessed.
 */
export function roomHint(entry: ListEntry): string | null {
  const room = entry.room;
  if (!room || entry.kind === 'direct' || room.public === null || room.memberCount === null) return null;
  const count = room.memberCount;
  return room.public
    ? fmt(_n('Public room · {count} member', 'Public room · {count} members', count), { count })
    : fmt(_n('Room · {count} member', 'Room · {count} members', count), { count });
}

/** Stable id for the merged "Note to self" row. */
const NOTE_TO_SELF_ID = 'note-to-self';

/** One row that stands for several: the newest member decides the badge, time and preview. */
function mergeEntries(
  id: string,
  title: string,
  members: ListEntry[],
  manual = false,
  pin: string | null = null,
): ListEntry {
  const newestOf = (list: ListEntry[]) =>
    list.reduce((a, b) => ((a.lastMessageAt ?? '') >= (b.lastMessageAt ?? '') ? a : b));
  const newest = newestOf(members);
  // A pinned row shows the pinned network's badge; the time stays the real latest activity.
  const pinned = pin === null ? [] : members.filter((m) => m.backend === pin);
  const badge = pinned.length > 0 ? newestOf(pinned) : newest;
  return {
    id,
    conversationIds: members.flatMap((m) => m.conversationIds),
    title,
    backend: badge.backend,
    accountId: badge.accountId,
    kind: 'direct',
    unread: members.reduce((sum, m) => sum + m.unread, 0),
    lastMessageAt: newest.lastMessageAt,
    target: null,
    emailChat: members.some((m) => m.emailChat),
    room: null,
    members,
    personIds: [...new Set(members.flatMap((m) => m.personIds))],
    manual,
    pin,
  };
}

/**
 * Rows of the same person become ONE row, whichever networks they came in on. Same person means
 * the same directory participant (what the address book positively owns) or two participants the
 * person merged by hand. Canonical conversations stay untouched: their ids travel with the row.
 */
export function mergePeople(
  entries: ListEntry[],
  merges: PersonMerges = [],
  pins: PersonPins = {},
): ListEntry[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const up = parent.get(id);
    if (up === undefined || up === id) return id;
    const root = find(up);
    parent.set(id, root);
    return root;
  };
  for (const group of merges) {
    const [first, ...others] = group;
    if (first === undefined) continue;
    for (const other of others) parent.set(find(other), find(first));
  }
  const buckets = new Map<string, ListEntry[]>();
  const out: ListEntry[] = [];
  for (const entry of entries) {
    const person = entry.personIds[0];
    if (person === undefined) {
      out.push(entry);
      continue;
    }
    const key = find(person);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else {
      buckets.set(key, [entry]);
      // The bucket's row takes the place of its first entry, so the order of the list is kept.
      out.push(entry);
    }
  }
  return out
    .map((entry) => {
      const person = entry.personIds[0];
      const bucket = person === undefined ? undefined : buckets.get(find(person));
      if (!bucket || bucket.length < 2) return entry;
      if (bucket[0] !== entry) return null;
      const people = [...new Set(bucket.flatMap((m) => m.personIds))].sort();
      const newest = bucket.reduce((a, b) => ((a.lastMessageAt ?? '') >= (b.lastMessageAt ?? '') ? a : b));
      // Any id of the row may carry the pin; on a conflict the smallest id wins.
      const pinId = people.find((id) => pins[id] !== undefined);
      return mergeEntries(
        `person:${people[0]}`,
        newest.title,
        bucket,
        people.length > 1,
        pinId === undefined ? null : pins[pinId]!,
      );
    })
    .filter((entry): entry is ListEntry => entry !== null);
}

/** Merge every self-chat into one row, newest message picking the visible protocol. */
function mergeSelfEntries(members: ListEntry[]): ListEntry {
  return mergeEntries(NOTE_TO_SELF_ID, _('Note to self'), members);
}

/**
 * Direct mail threads with the same person become ONE presentation conversation. Canonical threads
 * stay untouched: their ids travel with the row, and replies still use RFC 5322 references.
 */
export function toEntries(
  conversations: Conversation[],
  showAllEmails = true,
  identities: ReadonlyMap<string, string> = new Map(),
  rooms: ReadonlyMap<string, RoomFacts> = new Map(),
  merges: PersonMerges = [],
  pins: PersonPins = {},
): ListEntry[] {
  const entries: ListEntry[] = [];
  const mailContacts = new Map<string, ListEntry>();
  const selfEntries: ListEntry[] = [];
  for (const conversation of conversations) {
    if (conversation.backend === 'mail' && !showAllEmails && !conversation.emailChat) continue;
    const identity = identities.get(conversation.accountId);
    const entry = toEntry(conversation, identity, rooms.get(conversation.id) ?? null);
    if (selfAddressOf(conversation, identity) !== null) {
      selfEntries.push(entry);
      continue;
    }
    const participant = conversation.participants.length === 1 ? conversation.participants[0] : null;
    if (conversation.backend !== 'mail' || conversation.kind !== 'direct' || !participant || !entry.target) {
      entries.push(entry);
      continue;
    }
    const key = `${conversation.accountId}\u0000${participant.id}`;
    const existing = mailContacts.get(key);
    if (!existing) {
      entry.id = `mail-contact:${conversation.accountId}:${participant.id}`;
      mailContacts.set(key, entry);
      entries.push(entry);
      continue;
    }
    existing.conversationIds.push(conversation.id);
    existing.unread += entry.unread;
    existing.emailChat ||= entry.emailChat;
    if ((entry.lastMessageAt ?? '') > (existing.lastMessageAt ?? ''))
      existing.lastMessageAt = entry.lastMessageAt;
  }
  const people = mergePeople(entries, merges, pins);
  if (selfEntries.length > 0) people.push(mergeSelfEntries(selfEntries));
  return people;
}

/**
 * Unread in tiers (docs/design/ui.md). The index keeps one count, so only the grey count exists
 * today; the accent tier (a mention) and the dot (activity without a count) need data the
 * backends do not store yet.
 */
export type UnreadTier = 'count' | 'none';

export const unreadTier = (entry: ListEntry): UnreadTier => (entry.unread > 0 ? 'count' : 'none');

/** "99+" rather than a number that stretches the row. */
export const unreadText = (count: number): string => (count > 99 ? '99+' : String(count));

/** The rows that carry the chat: the members of a merged row, else the row itself. */
const carriers = (entry: ListEntry): ListEntry[] => (entry.members.length > 0 ? entry.members : [entry]);

const hitOf = (entry: ListEntry, filter: ListFilter): string | undefined => {
  for (const id of entry.conversationIds) {
    const line = filter.hits?.get(id);
    if (line !== undefined) return line;
  }
  return undefined;
};

export function matches(entry: ListEntry, filter: ListFilter): boolean {
  const query = filter.query.trim().toLowerCase();
  if (query !== '' && !entry.title.toLowerCase().includes(query) && !hitOf(entry, filter)) return false;
  // A merged row stays while any of its carriers passes the protocol and account filter.
  return carriers(entry).some((carrier) => {
    if (filter.backends.size > 0 && !filter.backends.has(carrier.backend)) return false;
    // Accounts narrow only within their own protocol, and only while that protocol is chosen.
    const own = filter.backends.has(carrier.backend) ? filter.accounts.get(carrier.backend) : undefined;
    return own === undefined || own.size === 0 || own.has(carrier.accountId);
  });
}

/** Newest first; an undated conversation sinks; the id keeps ties stable. */
function newestFirst(a: ListEntry, b: ListEntry): number {
  if (a.lastMessageAt !== b.lastMessageAt) {
    if (a.lastMessageAt === null) return 1;
    if (b.lastMessageAt === null) return -1;
    return a.lastMessageAt < b.lastMessageAt ? 1 : -1;
  }
  return a.id < b.id ? -1 : 1;
}

/** The sections that have something in them, people first. */
export function buildSections(entries: ListEntry[], filter: ListFilter = NO_FILTER): Section[] {
  // While searching, a row whose messages matched shows the matching line instead of the newest one.
  const searching = filter.query.trim() !== '';
  const shown = entries
    .filter((entry) => matches(entry, filter))
    .map((entry) => {
      const line = searching ? hitOf(entry, filter) : undefined;
      return line === undefined ? entry : { ...entry, preview: oneLine(line) };
    })
    .sort(newestFirst);
  const defs: Array<{ id: SectionId; title: string; kind: Conversation['kind'] }> = [
    { id: 'people', title: _('People'), kind: 'direct' },
    { id: 'groups', title: _('Groups'), kind: 'group' },
  ];
  return defs
    .map(({ id, title, kind }) => {
      const own = shown.filter((entry) => entry.kind === kind);
      return { id, title, entries: own, unread: own.filter((entry) => entry.unread > 0).length };
    })
    .filter((section) => section.entries.length > 0);
}

/** Protocols present in the list, for the filter chips; one chip is no filter, so it is not offered. */
export function backendChoices(entries: ListEntry[]): string[] {
  const found = [...new Set(entries.flatMap(carriers).map((entry) => entry.backend))].sort();
  return found.length > 1 ? found : [];
}

export interface AccountGroup {
  backend: string;
  accounts: string[];
}

/**
 * Account chips, grouped under their protocol. Offered only for a chosen protocol that holds more
 * than one account: account ids are not names a person reads, and one account is no choice.
 */
export function accountChoices(entries: ListEntry[], backends: ReadonlySet<string>): AccountGroup[] {
  const groups: AccountGroup[] = [];
  for (const backend of [...backends].sort()) {
    const accounts = [
      ...new Set(
        entries
          .flatMap(carriers)
          .filter((entry) => entry.backend === backend)
          .map((entry) => entry.accountId),
      ),
    ].sort();
    if (accounts.length > 1) groups.push({ backend, accounts });
  }
  return groups;
}

/** Account choices of protocols that are not chosen (any more) are dropped, in place. */
export function dropDeselectedAccounts(
  accounts: Map<string, Set<string>>,
  backends: ReadonlySet<string>,
): void {
  for (const backend of accounts.keys()) if (!backends.has(backend)) accounts.delete(backend);
}

/** Up to two letters for the avatar: first letters of the first two words. */
export function initials(title: string): string {
  const words = title
    .split(/\s+/)
    .map((word) => [...word.replace(/^[^\p{L}\p{N}]+/u, '')][0] ?? '')
    .filter((letter) => letter !== '');
  return words.slice(0, 2).join('').toUpperCase();
}
