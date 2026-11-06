/**
 * The combined conversation list: what is shown and in which order, with no widget in sight.
 *
 * One list across every messenger, organised by function (docs/design/ui.md): people and groups
 * as sections, protocol and account as filters. A conversation is asked what it IS (`kind`), never
 * "is this Signal?"; the backend name only picks the badge and the filter chip.
 */

import type { AddressKind, Conversation } from '@curlew/protocol';
import { _ } from '@curlew/protocol';

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
  /** Address the composer answers, when this is a direct conversation. */
  target: string | null;
  emailChat: boolean;
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
}

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
 * - WhatsApp: the account id is a registration id and the identity a display name, so the own JID
 *   is not in the index; not recognised.
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

function targetOf(conversation: Conversation): string | null {
  if (conversation.kind !== 'direct' || conversation.participants.length !== 1) return null;
  const kind = SEND_KIND[conversation.backend];
  if (kind === undefined) return null;
  return conversation.participants[0].addresses.find((address) => address.kind === kind)?.value ?? null;
}

/** `identities`: account id → the address the account is known by, as the index stores it. */
export function toEntry(conversation: Conversation, identity?: string): ListEntry {
  return {
    id: conversation.id,
    conversationIds: [conversation.id],
    title: entryTitle(conversation, identity),
    backend: conversation.backend,
    accountId: conversation.accountId,
    kind: conversation.kind,
    unread: Math.max(0, conversation.unreadCount),
    lastMessageAt: conversation.lastMessageAt,
    target: selfAddressOf(conversation, identity) ?? targetOf(conversation),
    emailChat: conversation.emailChat,
  };
}

/**
 * Direct mail threads with the same person become ONE presentation conversation. Canonical threads
 * stay untouched: their ids travel with the row, and replies still use RFC 5322 references.
 */
export function toEntries(
  conversations: Conversation[],
  showAllEmails = true,
  identities: ReadonlyMap<string, string> = new Map(),
): ListEntry[] {
  const entries: ListEntry[] = [];
  const mailContacts = new Map<string, ListEntry>();
  for (const conversation of conversations) {
    if (conversation.backend === 'mail' && !showAllEmails && !conversation.emailChat) continue;
    const entry = toEntry(conversation, identities.get(conversation.accountId));
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
    if ((entry.lastMessageAt ?? '') > (existing.lastMessageAt ?? '')) existing.lastMessageAt = entry.lastMessageAt;
  }
  return entries;
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

export function matches(entry: ListEntry, filter: ListFilter): boolean {
  if (filter.backends.size > 0 && !filter.backends.has(entry.backend)) return false;
  // Accounts narrow only within their own protocol, and only while that protocol is chosen.
  const own = filter.backends.has(entry.backend) ? filter.accounts.get(entry.backend) : undefined;
  if (own !== undefined && own.size > 0 && !own.has(entry.accountId)) return false;
  const query = filter.query.trim().toLowerCase();
  return query === '' || entry.title.toLowerCase().includes(query);
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
  const shown = entries.filter((entry) => matches(entry, filter)).sort(newestFirst);
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
  const found = [...new Set(entries.map((entry) => entry.backend))].sort();
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
      ...new Set(entries.filter((entry) => entry.backend === backend).map((entry) => entry.accountId)),
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
  for (const backend of [...accounts.keys()]) if (!backends.has(backend)) accounts.delete(backend);
}

/** Up to two letters for the avatar: first letters of the first two words. */
export function initials(title: string): string {
  const words = title
    .split(/\s+/)
    .map((word) => [...word.replace(/^[^\p{L}\p{N}]+/u, '')][0] ?? '')
    .filter((letter) => letter !== '');
  return words.slice(0, 2).join('').toUpperCase();
}
