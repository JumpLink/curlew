/**
 * Agent access per account and contact — the policy core of ADR 0009.
 *
 * A rule has a scope (an account, or one account/contact pair) and two modes, one for reading
 * message bodies and one for writing. Resolution fails closed: the person's own address is
 * allowed, the most specific rule that SAYS something about the kind decides, an explicit `deny`
 * is final, no rule means `ask` or `deny` by the `askWithoutRule` switch, and only then can a
 * temporary grant turn an `ask` into an `allow`.
 *
 * Pure, so every rule is tested on both runtimes. This file only decides; asking the person and
 * the call sites that enforce it (MCP, CLI) are later steps. Config error strings stay English,
 * like those of `grants.ts`: they name config keys and are read by whoever edits the file.
 */

import { type Grant, isSendCapability } from './grants.ts';

export type Mode = 'allow' | 'ask' | 'deny';
export type Kind = 'read' | 'write';

export const MODES: readonly Mode[] = ['allow', 'ask', 'deny'];

/** One rule as the config spells it. A missing `read` or `write` says nothing about that kind. */
export interface AccessRule {
  account: string;
  /** A conversation address exactly as the backend spells it. Absent = the whole account. */
  contact?: string;
  read?: Mode;
  write?: Mode;
}

/** A rule in the effective policy; `migrated` marks one derived from an old `<backend>.send` grant. */
export interface PolicyRule extends AccessRule {
  migrated?: true;
}

export interface AgentAccessPolicy {
  /** `true` (default): a request no rule covers is `ask`. `false`: it is `deny`. */
  askWithoutRule: boolean;
  /**
   * `true`: a write that an `allow` rule covers also sends files without asking, for mail and
   * chats alike. Absent or `false` (default): a send that names files is always put to the person.
   */
  sendFilesUnasked?: boolean;
  rules: PolicyRule[];
}

/** Why a request got its mode — the write log records this later (ADR 0009 §10). */
export type Reason = 'self' | 'rule' | 'migrated' | 'default' | 'temporary';

export interface Resolution {
  mode: Mode;
  reason: Reason;
}

/** A grant that lives in memory only: for one session, optionally ending by time as well. */
export interface TemporaryGrant {
  account: string;
  /** Absent = the whole account. */
  contact?: string;
  kind: Kind;
  session: string;
  /** Epoch milliseconds; the grant is over at this instant. Absent = until the session ends. */
  expiresAt?: number;
}

export interface TemporaryContext {
  grants: readonly TemporaryGrant[];
  /** The session making the request. */
  session: string;
  /** Epoch milliseconds, passed in so the decision stays pure. */
  now: number;
}

export interface AccessRequest {
  account: string;
  /** Absent for a request about the account as a whole. */
  contact?: string;
  kind: Kind;
  /** `SendBackend.isSelfAddress` answered yes for this contact. */
  self?: boolean;
  temporary?: TemporaryContext;
}

export type ParseAgentAccessResult =
  | { ok: true; policy: AgentAccessPolicy }
  | { ok: false; errors: string[] };

export function defaultAgentAccess(): AgentAccessPolicy {
  return { askWithoutRule: true, rules: [] };
}

const WILDCARD = /[*?]/;
const RULE_KEYS = ['account', 'contact', 'read', 'write'];
const POLICY_KEYS = ['askWithoutRule', 'sendFilesUnasked', 'rules'];

function scopeKey(account: string, contact: string | undefined): string {
  return JSON.stringify([account, contact ?? null]);
}

function stringProblem(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'must be a string';
  if (value.length === 0 || value.trim() !== value)
    return 'must be a non-empty string without surrounding whitespace';
  if (WILDCARD.test(value)) return 'must name exactly one target, wildcards are not allowed';
  return undefined;
}

/**
 * Validate `config.agentAccess` and fold in the old `<backend>.send` grants.
 *
 * Every problem is collected, each naming its rule, so one edit can fix the lot. An old send grant
 * (`<account>/<address>`) becomes a contact rule with read and write `allow`, in memory, whether
 * or not `agentAccess` is present. A contact rule written out for the same pair replaces the
 * migrated one outright: what the person wrote today beats what a grant implied.
 */
export function parseAgentAccess(raw: unknown, legacyGrants: readonly Grant[] = []): ParseAgentAccessResult {
  const errors: string[] = [];
  const explicit: PolicyRule[] = [];
  let askWithoutRule = true;
  let sendFilesUnasked = false;

  if (raw !== undefined) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, errors: ['config.agentAccess must be an object { askWithoutRule, rules }'] };
    }
    const policy = raw as Record<string, unknown>;
    for (const key of Object.keys(policy)) {
      if (!POLICY_KEYS.includes(key)) errors.push(`config.agentAccess.${key} is not an agentAccess field`);
    }
    if (policy.askWithoutRule !== undefined) {
      if (typeof policy.askWithoutRule === 'boolean') askWithoutRule = policy.askWithoutRule;
      else errors.push('config.agentAccess.askWithoutRule must be true or false');
    }
    if (policy.sendFilesUnasked !== undefined) {
      if (typeof policy.sendFilesUnasked === 'boolean') sendFilesUnasked = policy.sendFilesUnasked;
      else errors.push('config.agentAccess.sendFilesUnasked must be true or false');
    }
    if (policy.rules !== undefined) {
      if (!Array.isArray(policy.rules)) {
        errors.push('config.agentAccess.rules must be a list of rules');
      } else {
        const seen = new Map<string, number>();
        policy.rules.forEach((entry: unknown, index) => {
          const rule = parseRule(entry, index, errors);
          if (!rule) return;
          const key = scopeKey(rule.account, rule.contact);
          const first = seen.get(key);
          if (first !== undefined) {
            errors.push(
              `config.agentAccess.rules[${index}] has the same scope as rules[${first}]; one rule per scope`,
            );
            return;
          }
          seen.set(key, index);
          explicit.push(rule);
        });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const taken = new Set(explicit.map((rule) => scopeKey(rule.account, rule.contact)));
  const migrated: PolicyRule[] = [];
  for (const grant of legacyGrants) {
    if (!isSendCapability(grant.capability)) continue;
    const slash = grant.target.indexOf('/');
    if (slash <= 0 || slash === grant.target.length - 1) continue;
    const account = grant.target.slice(0, slash);
    const contact = grant.target.slice(slash + 1);
    const key = scopeKey(account, contact);
    if (taken.has(key)) continue;
    taken.add(key);
    migrated.push({ account, contact, read: 'allow', write: 'allow', migrated: true });
  }

  return {
    ok: true,
    policy: {
      askWithoutRule,
      ...(sendFilesUnasked ? { sendFilesUnasked } : {}),
      rules: [...explicit, ...migrated],
    },
  };
}

function parseRule(entry: unknown, index: number, errors: string[]): PolicyRule | undefined {
  const where = `config.agentAccess.rules[${index}]`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    errors.push(`${where} must be an object { account, contact?, read?, write? }`);
    return undefined;
  }
  const fields = entry as Record<string, unknown>;
  const before = errors.length;
  for (const key of Object.keys(fields)) {
    if (!RULE_KEYS.includes(key)) errors.push(`${where}.${key} is not a rule field`);
  }

  const accountProblem = stringProblem(fields.account);
  if (accountProblem) errors.push(`${where}.account ${accountProblem}`);
  else if ((fields.account as string).includes('/'))
    errors.push(`${where}.account must be an account id, not "<account>/<address>"`);
  if (fields.contact !== undefined) {
    const contactProblem = stringProblem(fields.contact);
    if (contactProblem) errors.push(`${where}.contact ${contactProblem}`);
  }

  const modes: { read?: Mode; write?: Mode } = {};
  for (const kind of ['read', 'write'] as const) {
    const value = fields[kind];
    if (value === undefined) continue;
    if (typeof value === 'string' && (MODES as readonly string[]).includes(value))
      modes[kind] = value as Mode;
    else errors.push(`${where}.${kind} ${JSON.stringify(value)} must be "allow", "ask" or "deny"`);
  }
  if (fields.read === undefined && fields.write === undefined) {
    errors.push(`${where} needs a read or a write mode; a rule without either says nothing`);
  }
  if (modes.read === 'deny' && (modes.write === 'allow' || modes.write === 'ask')) {
    errors.push(
      `${where} sets write "${modes.write}" with read "deny"; a conversation an agent may write to is one it may read`,
    );
  }

  if (errors.length > before) return undefined;
  return {
    account: fields.account as string,
    ...(fields.contact !== undefined ? { contact: fields.contact as string } : {}),
    ...modes,
  };
}

/** Find the mode the most specific rule that names this kind gives, and which rule it was. */
function ruleMode(policy: AgentAccessPolicy, request: AccessRequest, kind: Kind): Resolution | undefined {
  const specific =
    request.contact === undefined
      ? undefined
      : policy.rules.find((rule) => rule.account === request.account && rule.contact === request.contact);
  const broad = policy.rules.find((rule) => rule.account === request.account && rule.contact === undefined);
  for (const rule of [specific, broad]) {
    const mode = rule?.[kind];
    if (rule && mode !== undefined) return { mode, reason: rule.migrated ? 'migrated' : 'rule' };
  }
  return undefined;
}

/** Does a live grant of this session cover this account, contact and kind? */
export function matchTemporaryGrant(
  context: TemporaryContext,
  request: Pick<AccessRequest, 'account' | 'contact' | 'kind'>,
): boolean {
  return context.grants.some(
    (grant) =>
      grant.session === context.session &&
      grant.kind === request.kind &&
      grant.account === request.account &&
      (grant.contact === undefined || grant.contact === request.contact) &&
      (grant.expiresAt === undefined || context.now < grant.expiresAt),
  );
}

function resolveKind(policy: AgentAccessPolicy, request: AccessRequest, kind: Kind): Resolution {
  const decided: Resolution = ruleMode(policy, request, kind) ?? {
    mode: policy.askWithoutRule ? 'ask' : 'deny',
    reason: 'default',
  };
  // Only `ask` widens: `deny` is final and `allow` needs no grant.
  if (
    decided.mode === 'ask' &&
    request.temporary &&
    matchTemporaryGrant(request.temporary, { account: request.account, contact: request.contact, kind })
  ) {
    return { mode: 'allow', reason: 'temporary' };
  }
  return decided;
}

/**
 * The final mode for one request, and why. Never throws: a request nothing allows is `deny` or
 * `ask`, and `ask` is `deny` wherever no prompt can be shown.
 */
export function resolve(policy: AgentAccessPolicy, request: AccessRequest): Resolution {
  if (request.self) return { mode: 'allow', reason: 'self' };
  const resolution = resolveKind(policy, request, request.kind);
  if (request.kind === 'write' && resolution.mode !== 'deny') {
    const read = resolveKind(policy, request, 'read');
    if (read.mode === 'deny') return read;
  }
  return resolution;
}

/** Add a grant; one with the same session, scope and kind is replaced, so a renewal extends it. */
export function addTemporaryGrant(
  grants: readonly TemporaryGrant[],
  grant: TemporaryGrant,
): TemporaryGrant[] {
  const same = (other: TemporaryGrant): boolean =>
    other.session === grant.session &&
    other.kind === grant.kind &&
    other.account === grant.account &&
    other.contact === grant.contact;
  return [...grants.filter((other) => !same(other)), grant];
}

/** Drop the grants that ran out by `now`. */
export function expireTemporaryGrants(grants: readonly TemporaryGrant[], now: number): TemporaryGrant[] {
  return grants.filter((grant) => grant.expiresAt === undefined || now < grant.expiresAt);
}

/** Drop every grant of one session, for when that session ends. */
export function endSession(grants: readonly TemporaryGrant[], session: string): TemporaryGrant[] {
  return grants.filter((grant) => grant.session !== session);
}
