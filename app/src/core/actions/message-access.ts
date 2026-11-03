/**
 * Whose conversation is a message? The contacts that ADR 0009 rules are written for.
 *
 * A mail message belongs to the person it came from. One the account sent itself belongs to the
 * people it went to — and to ALL of them, so a Cc cannot carry a body past a `deny`. Addresses are
 * compared exactly as the message spells them, like everywhere in the policy.
 */

import type { MailAddress, MailMessageDTO } from '@curlew/protocol';
import type { CurlewConfig } from '../config.ts';
import { type AgentAccess, requireAgentAccess } from './access.ts';
import { findAccountBackend, isSelf } from './send.ts';

export type SelfCheck = (account: string, address: string) => Promise<boolean>;

/** The addresses in a stored `Name <a@b>, c@d` list. */
export function emailsOf(list: string): string[] {
  const found: string[] = [];
  for (const match of list.matchAll(/<([^<>\s]+)>|([^\s,<>"]+@[^\s,<>"]+)/g)) {
    found.push(match[1] ?? match[2]);
  }
  return found;
}

export function emailsOfAddresses(list: readonly MailAddress[]): string[] {
  return list.map((a) => a.email);
}

/** Memoised: a search asks about the same address for every hit. */
export function selfChecker(config: CurlewConfig, agent: Pick<AgentAccess, 'isSelf'>): SelfCheck {
  if (agent.isSelf) return agent.isSelf;
  const memo = new Map<string, Promise<boolean>>();
  return (account, address) => {
    const key = JSON.stringify([account, address]);
    let known = memo.get(key);
    if (known === undefined) {
      known = findAccountBackend(config, account).then(
        (found) => (found === null ? false : isSelf(found.backend, found.account.id, address)),
        () => false,
      );
      memo.set(key, known);
    }
    return known;
  };
}

/** The contacts a mail message is with: the sender, or everyone it went to when the account sent it. */
export async function mailContacts(
  isSelfAddress: SelfCheck,
  account: string,
  from: readonly string[],
  others: readonly string[],
): Promise<string[]> {
  if (from.length > 0) {
    const own = await Promise.all(from.map((address) => isSelfAddress(account, address)));
    if (!own.every(Boolean)) return [...from];
  }
  return [...others];
}

/**
 * Require read access to the bodies of a chat or room, for every participant but the account
 * itself. A room id may not be among the participants, so a rule written for a room's address may
 * not match here — the rules of its members do.
 */
export async function requireParticipantsRead(
  config: CurlewConfig,
  agent: AgentAccess,
  account: string,
  addresses: readonly string[],
): Promise<void> {
  const isSelfAddress = selfChecker(config, agent);
  const others: string[] = [];
  for (const address of addresses) if (!(await isSelfAddress(account, address))) others.push(address);
  await requireAgentAccess(config, agent, account, others, 'read');
}

/** Require read access to a fetched mail message: to its sender, or to all its recipients when the account sent it. */
export async function requireMessageRead(
  config: CurlewConfig,
  agent: AgentAccess,
  message: Pick<MailMessageDTO, 'accountId' | 'from' | 'to' | 'cc'>,
): Promise<void> {
  const contacts = await mailContacts(
    selfChecker(config, agent),
    message.accountId,
    emailsOfAddresses(message.from),
    [...emailsOfAddresses(message.to), ...emailsOfAddresses(message.cc)],
  );
  await requireAgentAccess(config, agent, message.accountId, contacts, 'read');
}
