/**
 * Searches for an agent (ADR 0009): a search that reads message bodies spans contacts, so it is
 * filtered per contact and never answered whole. It never prompts — one prompt per hit would be a
 * flood — so what is not allowed by a rule or a grant of this session is withheld and counted; the
 * agent reads that conversation directly to be asked.
 *
 * A search over headers only (no `query`, no `body`) is metadata and stays readable.
 */

import { _, type MailSummaryDTO } from '@curlew/protocol';
import type { IndexedMessage, IndexSearchCriteria } from '@curlew/store';
import { configPath } from '@curlew/store';
import { loadConfig } from '../config.ts';
import { type AgentAccess, agentGate, filterByAccess } from './access.ts';
import { indexSearch } from './index-sync.ts';
import { type MailSearchParams, mailSearch } from './mail.ts';
import { emailsOf, emailsOfAddresses, mailContacts, selfChecker } from './message-access.ts';

export interface Withheld {
  /** Hits left out because the agent has no `read` access to their contact. */
  withheld: number;
}

/** The answer's fields for what was left out: the count, and what to do about it. */
export function withheldFields(withheld: number): { withheld: number; withheldHint?: string } {
  if (withheld === 0) return { withheld };
  return {
    withheld,
    withheldHint: _(
      'some hits are left out because you have no read access to their contact — a search never asks; read that conversation directly (conversations_get with include_bodies, or mail_get_message) to be asked, or add a read rule to config.agentAccess.rules',
    ),
  };
}

export async function mailSearchForAgent(
  params: MailSearchParams,
  agent: AgentAccess,
  cfgPath = configPath(),
): Promise<{ messages: MailSummaryDTO[] } & Withheld> {
  const messages = await mailSearch(params);
  if (params.query === undefined && params.body === undefined) return { messages, withheld: 0 };
  const config = loadConfig(cfgPath);
  const isSelfAddress = selfChecker(config, agent);
  const contactsOf = new Map<MailSummaryDTO, string[]>();
  for (const m of messages) {
    contactsOf.set(
      m,
      await mailContacts(isSelfAddress, m.accountId, emailsOfAddresses(m.from), emailsOfAddresses(m.to)),
    );
  }
  const { kept, withheld } = await filterByAccess(agentGate(config, agent), messages, (m) => ({
    account: m.accountId,
    contacts: contactsOf.get(m) ?? [],
  }));
  return { messages: kept, withheld };
}

export async function indexSearchForAgent(
  criteria: IndexSearchCriteria,
  agent: AgentAccess,
  dbPath?: string,
  cfgPath = configPath(),
): Promise<{ messages: IndexedMessage[]; staleFolders: number; indexedAt: string | null } & Withheld> {
  const found = indexSearch(criteria, dbPath);
  if (criteria.query === undefined) return { ...found, withheld: 0 };
  const config = loadConfig(cfgPath);
  const isSelfAddress = selfChecker(config, agent);
  const contactsOf = new Map<IndexedMessage, string[]>();
  for (const m of found.messages) {
    contactsOf.set(
      m,
      await mailContacts(isSelfAddress, m.accountId, emailsOf(m.sender), emailsOf(m.recipients)),
    );
  }
  const { kept, withheld } = await filterByAccess(agentGate(config, agent), found.messages, (m) => ({
    account: m.accountId,
    contacts: contactsOf.get(m) ?? [],
  }));
  return { ...found, messages: kept, withheld };
}
