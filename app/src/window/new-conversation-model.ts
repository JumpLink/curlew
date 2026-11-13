/**
 * Starting a conversation with a contact who has none yet: which of the contact's addresses can
 * carry a first message, and the draft row the window shows until the index has a conversation.
 *
 * Only addresses the app can send to without asking the network first count. An XMPP address (a
 * JID) and a mail address are exactly that; a phone number is not, because Signal, WhatsApp and
 * Telegram each have to resolve it to an account of their own before anything can go out, and
 * Matrix has no field for it in an address book. Those protocols join in once that lookup exists.
 */

import type { ContactDTO } from '@curlew/protocol';
import { _ } from '@curlew/protocol';

import { carriersOf, protocolLabel, type ListEntry } from './conversation-list-model.ts';
import { trustRank } from './conversation-model.ts';

/** An account of a protocol that takes a bare address. */
export interface RouteAccount {
  backend: string;
  accountId: string;
  /** A mail account opted into Delta Chat: a first message from it is an email chat. */
  deltaChat?: boolean;
}

const ADDRESS_BACKENDS = ['xmpp', 'mail'] as const;

function addressesOf(contact: ContactDTO, backend: string): string[] {
  const found = backend === 'xmpp' ? (contact.jids ?? []) : backend === 'mail' ? contact.emails : [];
  return found.map((a) => a.trim()).filter((a) => a !== '');
}

/** The accounts the window already knows (rows and their members) that can send to a bare address. */
export function routeAccounts(
  entries: readonly ListEntry[],
  deltaChatAccounts: readonly string[] = [],
): RouteAccount[] {
  const seen = new Map<string, RouteAccount>();
  const visit = (e: ListEntry) => {
    if (!(ADDRESS_BACKENDS as readonly string[]).includes(e.backend)) return;
    seen.set(`${e.backend}\u0000${e.accountId}`, {
      backend: e.backend,
      accountId: e.accountId,
      ...(e.backend === 'mail' && deltaChatAccounts.includes(e.accountId) ? { deltaChat: true } : {}),
    });
  };
  for (const e of entries) {
    visit(e);
    e.members.forEach(visit);
  }
  return [...seen.values()];
}

/** One member row per account the contact can be written through; the first address per protocol. */
function routeMembers(contact: ContactDTO, accounts: readonly RouteAccount[]): ListEntry[] {
  const members: ListEntry[] = [];
  for (const account of accounts) {
    const target = addressesOf(contact, account.backend)[0];
    if (target === undefined) continue;
    members.push({
      id: `new:${contact.uid}:${account.accountId}`,
      conversationIds: [],
      title: contact.name.trim() || target,
      backend: account.backend,
      accountId: account.accountId,
      kind: 'direct',
      unread: 0,
      lastMessageAt: null,
      target,
      emailChat: account.backend === 'mail' && account.deltaChat === true,
      room: null,
      members: [],
      personIds: [],
      manual: false,
      pin: null,
    });
  }
  return members.sort((a, b) => trustRank(a.backend) - trustRank(b.backend));
}

/** Protocols the contact can be reached on, most trusted first; empty when none fits. */
export function contactProtocols(contact: ContactDTO, accounts: readonly RouteAccount[]): string[] {
  return [...new Set(routeMembers(contact, accounts).map((m) => m.backend))];
}

/** "XMPP · Mail": what a row in the picker says about the contact. */
export function contactSubtitle(contact: ContactDTO, accounts: readonly RouteAccount[]): string {
  return carriersOf(routeMembers(contact, accounts)).map(protocolLabel).join(' · ');
}

/** The row to open for a contact who has no conversation yet; null when no address fits. */
export function draftEntry(contact: ContactDTO, accounts: readonly RouteAccount[]): ListEntry | null {
  const members = routeMembers(contact, accounts);
  const first = members[0];
  if (first === undefined) return null;
  return {
    ...first,
    id: `new:${contact.uid}`,
    members,
    target: null,
    emailChat: false,
  };
}

/** The existing direct row that already writes to one of the contact's addresses, if any. */
export function existingEntry(entries: readonly ListEntry[], contact: ContactDTO): ListEntry | null {
  const wanted = new Set(
    ADDRESS_BACKENDS.flatMap((b) => addressesOf(contact, b)).map((a) => a.toLowerCase()),
  );
  const writes = (e: ListEntry) =>
    e.kind === 'direct' && e.target !== null && wanted.has(e.target.toLowerCase());
  return entries.find((e) => writes(e) || e.members.some(writes)) ?? null;
}

/** True when the query (blank matches all) is part of the name, the organisation or an address. */
export function contactMatches(contact: ContactDTO, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return [contact.name, contact.org ?? '', ...contact.emails, ...(contact.jids ?? [])].some((s) =>
    s.toLowerCase().includes(q),
  );
}

/** The contacts to offer: those with a usable address, matching the query, by name. */
export function offeredContacts(
  contacts: readonly ContactDTO[],
  accounts: readonly RouteAccount[],
  query: string,
): ContactDTO[] {
  return contacts
    .filter((c) => contactMatches(c, query) && contactProtocols(c, accounts).length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Why the picker is empty, so the person knows whether to type less or add an address. */
export function emptyMessage(searching: boolean): string {
  return searching ? _('No contact fits the search') : _('No contacts with an XMPP or mail address');
}
