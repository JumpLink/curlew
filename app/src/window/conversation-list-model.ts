/**
 * The combined conversation list: what is shown and in which order, with no widget in sight.
 *
 * One list across every messenger, organised by function (docs/design/ui.md): people and groups
 * as sections, protocol and account as filters. A conversation is asked what it IS (`kind`), never
 * "is this Signal?"; the backend name only picks the badge and the filter chip.
 */

import type { Conversation } from '@curlew/protocol';
import { _ } from '@curlew/protocol';

export type SectionId = 'people' | 'groups';

/** A conversation reduced to what a row needs. */
export interface ListEntry {
  id: string;
  title: string;
  backend: string;
  accountId: string;
  kind: Conversation['kind'];
  unread: number;
  lastMessageAt: string | null;
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
  /** Empty = every account. */
  accounts: ReadonlySet<string>;
  query: string;
}

export const NO_FILTER: ListFilter = { backends: new Set(), accounts: new Set(), query: '' };

const PROTOCOLS: Record<string, { label: () => string; icon: string }> = {
  mail: { label: () => _('Mail'), icon: 'mail-unread-symbolic' },
  xmpp: { label: () => _('XMPP'), icon: 'chat-bubble-text-symbolic' },
  signal: { label: () => _('Signal'), icon: 'chat-bubble-text-symbolic' },
  matrix: { label: () => _('Matrix'), icon: 'chat-bubble-text-symbolic' },
  telegram: { label: () => _('Telegram'), icon: 'chat-bubble-text-symbolic' },
  whatsapp: { label: () => _('WhatsApp'), icon: 'chat-bubble-text-symbolic' },
};

const FALLBACK_ICON = 'network-workgroup-symbolic';

/** The name a person knows the protocol by; an unknown backend shows its own name. */
export function protocolLabel(backend: string): string {
  return PROTOCOLS[backend]?.label() ?? backend;
}

/**
 * A neutral themed symbolic icon: the protocols' own logos are trademarks with their own licences,
 * so the badge says "mail" or "chat" and the tooltip names the protocol.
 */
export function protocolIcon(backend: string): string {
  return PROTOCOLS[backend]?.icon ?? FALLBACK_ICON;
}

/** The title a row shows: the stored one, else the people in it, else the first address. */
export function entryTitle(conversation: Conversation): string {
  const stored = conversation.title?.trim();
  if (stored) return stored;
  const names = conversation.participants
    .map((p) => p.displayName?.trim() || p.addresses[0]?.value || '')
    .filter((name) => name !== '');
  return names.length > 0 ? names.join(', ') : _('Unnamed conversation');
}

export function toEntry(conversation: Conversation): ListEntry {
  return {
    id: conversation.id,
    title: entryTitle(conversation),
    backend: conversation.backend,
    accountId: conversation.accountId,
    kind: conversation.kind,
    unread: Math.max(0, conversation.unreadCount),
    lastMessageAt: conversation.lastMessageAt,
  };
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
  if (filter.accounts.size > 0 && !filter.accounts.has(entry.accountId)) return false;
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

/** Accounts present (within the chosen protocols), for the filter chips; likewise only when there is a choice. */
export function accountChoices(entries: ListEntry[], backends: ReadonlySet<string>): string[] {
  const found = [
    ...new Set(
      entries.filter((entry) => backends.size === 0 || backends.has(entry.backend)).map((entry) => entry.accountId),
    ),
  ].sort();
  return found.length > 1 ? found : [];
}

/** Up to two letters for the avatar: first letters of the first two words. */
export function initials(title: string): string {
  const words = title
    .split(/\s+/)
    .map((word) => [...word.replace(/^[^\p{L}\p{N}]+/u, '')][0] ?? '')
    .filter((letter) => letter !== '');
  return words.slice(0, 2).join('').toUpperCase();
}
