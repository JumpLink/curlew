/**
 * The model behind the "Agent access" page (ADR 0009, step 5): what the page shows and every edit
 * it can make, as pure functions — no GTK, no filesystem — so both runtimes test them.
 *
 * An edit is a function `policy → result`, never "here is the whole policy now": the store applies
 * it to the file as it is on disk at that moment, so a rule the daemon's "Always" answer added
 * while the window was open is kept (see `agent-access-store.ts`).
 *
 * Migrated rules (derived in memory from an old `<backend>.send` grant) are shown, marked. The
 * first edit turns one into a real rule of its own — an explicit rule beats a migrated one when
 * the config is parsed — and removing one is refused: it lives in `grants`, which this page never
 * writes. Removing the explicit rule again makes the migrated one reappear.
 */

import {
  type AgentAccessPolicy,
  type Kind,
  type Mode,
  MODES,
  parseAgentAccess,
  type PolicyRule,
} from '../core/agent-access.ts';
import { sanitizeName } from '../core/lib/contact-name.ts';

/** What a rule says about one kind: a mode, or nothing (the broader rule, or the default, decides). */
export type Choice = 'unset' | Mode;
export const CHOICES: readonly Choice[] = ['unset', ...MODES];

export interface Scope {
  account: string;
  /** Absent = the whole account. */
  contact?: string;
}

export interface RuleView extends Scope {
  read: Choice;
  write: Choice;
  migrated: boolean;
  /** The sanitized display name, when the index has one for the contact. */
  name?: string;
}

export interface AccountView {
  account: string;
  /** The human label (the identity the backend reports), else the id. */
  label: string;
  /** The rule for the whole account, if there is one. */
  whole?: RuleView;
  /** Contact rules, sorted by name (when known) then address. */
  contacts: RuleView[];
}

export type EditError = 'write-needs-read' | 'needs-mode' | 'duplicate' | 'invalid' | 'missing' | 'migrated';

export type EditResult =
  | { ok: true; policy: AgentAccessPolicy }
  | { ok: false; error: EditError; detail?: string };

/** An edit, as the store applies it to the policy it has just read. */
export type PolicyEdit = (policy: AgentAccessPolicy) => EditResult;

export interface NewRule extends Scope {
  read?: Mode;
  write?: Mode;
}

const sameScope = (rule: Scope, scope: Scope): boolean =>
  rule.account === scope.account && rule.contact === scope.contact;

function view(rule: PolicyRule, nameOf?: (account: string, contact: string) => string | undefined): RuleView {
  const name = rule.contact === undefined ? undefined : sanitizeName(nameOf?.(rule.account, rule.contact));
  return {
    account: rule.account,
    ...(rule.contact !== undefined ? { contact: rule.contact } : {}),
    read: rule.read ?? 'unset',
    write: rule.write ?? 'unset',
    migrated: rule.migrated === true,
    ...(name !== undefined ? { name } : {}),
  };
}

/**
 * Group the rules by account, in the order the accounts first appear. `labels` maps an account id
 * to its human label; an id without one is shown as itself.
 */
export function groupByAccount(
  policy: AgentAccessPolicy,
  labels: ReadonlyMap<string, string> = new Map(),
  nameOf?: (account: string, contact: string) => string | undefined,
): AccountView[] {
  const groups = new Map<string, AccountView>();
  for (const rule of policy.rules) {
    let group = groups.get(rule.account);
    if (!group) {
      group = {
        account: rule.account,
        label: sanitizeName(labels.get(rule.account)) ?? rule.account,
        contacts: [],
      };
      groups.set(rule.account, group);
    }
    const row = view(rule, nameOf);
    if (rule.contact === undefined) group.whole = row;
    else group.contacts.push(row);
  }
  for (const group of groups.values()) {
    group.contacts.sort(
      (a, b) =>
        (a.name ?? a.contact ?? '').localeCompare(b.name ?? b.contact ?? '') ||
        (a.contact ?? '').localeCompare(b.contact ?? ''),
    );
  }
  return [...groups.values()];
}

/** The title of a rule row: `Name (address)`, the bare address without a name, or the whole account. */
export function ruleTitle(rule: RuleView, wholeAccountLabel: string): string {
  if (rule.contact === undefined) return wholeAccountLabel;
  return rule.name === undefined || rule.name === rule.contact
    ? rule.contact
    : `${rule.name} (${rule.contact})`;
}

/** Check the part of a policy that is written to the file: everything but the migrated rules. */
function checked(policy: AgentAccessPolicy): EditResult {
  const explicit = policy.rules.filter((rule) => !rule.migrated);
  const parsed = parseAgentAccess({
    askWithoutRule: policy.askWithoutRule,
    ...(policy.sendFilesUnasked ? { sendFilesUnasked: true } : {}),
    rules: explicit,
  });
  if (!parsed.ok) return { ok: false, error: 'invalid', detail: parsed.errors.join('; ') };
  return { ok: true, policy };
}

export function setAskWithoutRule(value: boolean): PolicyEdit {
  return (policy) => checked({ ...policy, askWithoutRule: value });
}

export function setSendFilesUnasked(value: boolean): PolicyEdit {
  return (policy) => checked({ ...policy, sendFilesUnasked: value });
}

/**
 * Set one mode of one rule. `deny` for reading takes a writing mode that would contradict it down
 * to `deny` too; allowing or asking to write a conversation that is not readable is refused, and
 * so is leaving a rule with neither mode. A migrated rule becomes an explicit one.
 */
export function setMode(scope: Scope, kind: Kind, choice: Choice): PolicyEdit {
  return (policy) => {
    const index = policy.rules.findIndex((rule) => sameScope(rule, scope));
    const current = policy.rules[index];
    if (!current) return { ok: false, error: 'missing' };
    const { migrated: _migrated, ...rest } = current;
    const next: PolicyRule = { ...rest };
    if (choice === 'unset') delete next[kind];
    else next[kind] = choice;
    if (kind === 'read' && choice === 'deny' && next.write !== undefined) next.write = 'deny';
    if (kind === 'write' && (choice === 'allow' || choice === 'ask') && next.read === 'deny') {
      return { ok: false, error: 'write-needs-read' };
    }
    if (next.read === undefined && next.write === undefined) return { ok: false, error: 'needs-mode' };
    const rules = policy.rules.map((rule, i) => (i === index ? next : rule));
    return checked({ ...policy, rules });
  };
}

/** Add a rule. A migrated rule for the same scope is replaced; an explicit one makes it a duplicate. */
export function addRule(rule: NewRule): PolicyEdit {
  return (policy) => {
    const account = rule.account.trim();
    const contact = rule.contact === undefined ? undefined : rule.contact.trim();
    if (account === '') return { ok: false, error: 'invalid', detail: 'account' };
    const scope: Scope = { account, ...(contact ? { contact } : {}) };
    if (rule.read === undefined && rule.write === undefined) return { ok: false, error: 'needs-mode' };
    if (rule.read === 'deny' && (rule.write === 'allow' || rule.write === 'ask')) {
      return { ok: false, error: 'write-needs-read' };
    }
    if (policy.rules.some((existing) => sameScope(existing, scope) && !existing.migrated)) {
      return { ok: false, error: 'duplicate' };
    }
    const added: PolicyRule = {
      ...scope,
      ...(rule.read !== undefined ? { read: rule.read } : {}),
      ...(rule.write !== undefined ? { write: rule.write } : {}),
    };
    const rules = [...policy.rules.filter((existing) => !sameScope(existing, scope)), added];
    return checked({ ...policy, rules });
  };
}

/** Remove one rule. A migrated rule is not here to remove: it lives in `grants`. */
export function removeRule(scope: Scope): PolicyEdit {
  return (policy) => {
    const found = policy.rules.find((rule) => sameScope(rule, scope));
    if (!found) return { ok: false, error: 'missing' };
    if (found.migrated) return { ok: false, error: 'migrated' };
    return checked({ ...policy, rules: policy.rules.filter((rule) => rule !== found) });
  };
}
