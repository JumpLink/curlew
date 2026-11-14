/**
 * Enforcing agent access (ADR 0009, step 2): what an AGENT frontend does with the policy.
 *
 * `agent-access.ts` decides; this file acts on the decision. An agent path — the MCP tools and the
 * CLI commands ADR 0008 names as agent frontends — calls `requireAccess` before it writes or
 * reads a message body, and `filterByAccess` over a search that spans contacts. The person's own
 * CLI and GTK use never come here.
 *
 *   - `allow` goes on. `deny` refuses with the config key to edit and an example rule.
 *   - `ask` goes to the daemon's prompt (`AccessPort`). No daemon, no notification server, no
 *     answer in two minutes, a dismissed notification and Deny are all a refusal that says which.
 *
 * Pure: the policy and the port are injected, so every branch is tested without a bus. The
 * daemon's side of the prompt is `access-broker.ts`; the Gio port is `lib/daemon-access-client.ts`.
 */

import { _, fmt } from '@curlew/protocol';
import { type AgentAccessPolicy, type Kind, type PolicyRule, resolve } from './agent-access.ts';
import type { CurlewConfig } from './config.ts';

/** How long the daemon waits for the person before the request is refused. */
export const ACCESS_PROMPT_TIMEOUT_MS = 120_000;

/** The frontends that are agents. The person's CLI use and the GTK app are not on this list. */
export type AgentFrontend = 'cli' | 'mcp';

/** Why an agent may go on. `self` and `rule`/`migrated` come from the policy, the rest from an answer. */
export type AllowReason = 'self' | 'rule' | 'migrated' | 'once' | 'session' | 'temporary';

/** Why the daemon said no. `policy` is a `deny` rule or an `ask` that no prompt may answer (probe). */
export type RefuseReason = 'policy' | 'denied' | 'denied-before' | 'timeout' | 'dismissed' | 'unavailable';

/** One request to the daemon's prompt service. */
export interface AccessAsk {
  account: string;
  /** Absent = the whole account. */
  contact?: string;
  kind: Kind;
  /** The MCP process's stable id, or a CLI call's own: one process, one session. */
  session: string;
  /** A CLI call: the prompt offers no "for this session", the answer is once or always. */
  oneShot: boolean;
  /** Write only: the start of the text, shown in the notification and never logged. */
  preview?: string;
  /** Write only: the file names (not paths, not content) the message carries, shown in the notification. */
  attachments?: string[];
  /** Answer from the policy and the session's grants only; never show a prompt. */
  probe?: boolean;
}

export type AccessReply = { allowed: true; reason: AllowReason } | { allowed: false; reason: RefuseReason };

/** How a request reaches the daemon. `null` = no daemon answered. A rejection is a failed call. */
export interface AccessPort {
  request(ask: AccessAsk): Promise<AccessReply | null>;
}

/** Everything one enforcement needs: the policy as loaded now, who is asking, where to ask. */
export interface AccessGate {
  policy: AgentAccessPolicy;
  port: AccessPort;
  session: string;
  oneShot: boolean;
}

/** An agent request that was refused. `reason` is for tests and the write log, the message for people. */
export class AccessDeniedError extends Error {
  readonly reason: RefuseReason;
  constructor(message: string, reason: RefuseReason) {
    super(message);
    this.name = 'AccessDeniedError';
    this.reason = reason;
  }
}

export interface AccessTarget {
  account: string;
  contact?: string;
  kind: Kind;
  /** `SendBackend.isSelfAddress` answered yes. */
  self?: boolean;
  preview?: string;
  attachments?: string[];
  /**
   * The files are read off the person's disk by a path the agent named, so no rule and no session
   * grant stands in for a yes: only the person's own address passes without asking.
   */
  confirmFiles?: boolean;
}

const PREVIEW_CHARS = 80;

/** The start of a text on one line, for a notification. */
export function previewOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return undefined;
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS - 1)}…`;
}

function describeTarget(target: Pick<AccessTarget, 'account' | 'contact'>): string {
  return target.contact === undefined ? target.account : `${target.account}/${target.contact}`;
}

function exampleRule(target: AccessTarget): string {
  return JSON.stringify({
    account: target.account,
    ...(target.contact === undefined ? {} : { contact: target.contact }),
    [target.kind]: 'allow',
  });
}

function deniedBySwitch(target: AccessTarget): AccessDeniedError {
  return new AccessDeniedError(
    fmt(
      _(
        'access to {target} is refused — AI access is off: switch it on in Preferences → AI (or set ui.ai to true in the config)',
      ),
      { target: describeTarget(target) },
    ),
    'policy',
  );
}

function deniedByPolicy(target: AccessTarget, byDefault: boolean): AccessDeniedError {
  const what = describeTarget(target);
  const values = { target: what, rule: exampleRule(target) };
  if (byDefault) {
    return new AccessDeniedError(
      target.kind === 'write'
        ? fmt(
            _(
              'sending to {target} is refused — no agentAccess rule covers it and config.agentAccess.askWithoutRule is false; add a rule like {rule} to config.agentAccess.rules',
            ),
            values,
          )
        : fmt(
            _(
              'reading messages of {target} is refused — no agentAccess rule covers it and config.agentAccess.askWithoutRule is false; add a rule like {rule} to config.agentAccess.rules',
            ),
            values,
          ),
      'policy',
    );
  }
  return new AccessDeniedError(
    target.kind === 'write'
      ? fmt(
          _(
            'sending to {target} is denied by config.agentAccess.rules — change the rule to allow it, for example {rule}',
          ),
          values,
        )
      : fmt(
          _(
            'reading messages of {target} is denied by config.agentAccess.rules — change the rule to allow it, for example {rule}',
          ),
          values,
        ),
    'policy',
  );
}

function refusedAfterAsking(target: AccessTarget, reason: RefuseReason): AccessDeniedError {
  const values = { target: describeTarget(target), rule: exampleRule(target) };
  const verb = target.kind === 'write' ? 'send' : 'read';
  switch (reason) {
    case 'denied':
      return new AccessDeniedError(
        verb === 'send'
          ? fmt(_('sending to {target} was declined in the prompt'), values)
          : fmt(_('reading messages of {target} was declined in the prompt'), values),
        reason,
      );
    case 'denied-before':
      return new AccessDeniedError(
        verb === 'send'
          ? fmt(
              _(
                'sending to {target} was declined earlier in this session — it is not asked again; add a rule like {rule} to allow it',
              ),
              values,
            )
          : fmt(
              _(
                'reading messages of {target} was declined earlier in this session — it is not asked again; add a rule like {rule} to allow it',
              ),
              values,
            ),
        reason,
      );
    case 'timeout':
      return new AccessDeniedError(
        verb === 'send'
          ? fmt(_('sending to {target} was refused — nobody answered the prompt within 2 minutes'), values)
          : fmt(
              _('reading messages of {target} was refused — nobody answered the prompt within 2 minutes'),
              values,
            ),
        reason,
      );
    case 'dismissed':
      return new AccessDeniedError(
        verb === 'send'
          ? fmt(_('sending to {target} was refused — the prompt was dismissed'), values)
          : fmt(_('reading messages of {target} was refused — the prompt was dismissed'), values),
        reason,
      );
    case 'unavailable':
      return new AccessDeniedError(
        verb === 'send'
          ? fmt(
              _(
                'sending to {target} was refused — the prompt could not be shown (no notification service); add a rule like {rule} to config.agentAccess.rules',
              ),
              values,
            )
          : fmt(
              _(
                'reading messages of {target} was refused — the prompt could not be shown (no notification service); add a rule like {rule} to config.agentAccess.rules',
              ),
              values,
            ),
        reason,
      );
    case 'policy':
      return deniedByPolicy(target, false);
  }
}

function noDaemon(target: AccessTarget, cause?: unknown): AccessDeniedError {
  const values = { target: describeTarget(target), rule: exampleRule(target) };
  const error = new AccessDeniedError(
    target.kind === 'write'
      ? fmt(
          _(
            'sending to {target} needs approval, but `curlew daemon` is not running, so nobody can be asked — start it, or add a rule like {rule} to config.agentAccess.rules',
          ),
          values,
        )
      : fmt(
          _(
            'reading messages of {target} needs approval, but `curlew daemon` is not running, so nobody can be asked — start it, or add a rule like {rule} to config.agentAccess.rules',
          ),
          values,
        ),
    'unavailable',
  );
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * Settle one account/contact/kind for an agent: return why it may go on, or throw an
 * `AccessDeniedError` that says what to do about it. The returned reason is what the write log
 * records.
 */
export async function requireAccess(gate: AccessGate, target: AccessTarget): Promise<AllowReason> {
  const resolution = resolve(gate.policy, {
    account: target.account,
    contact: target.contact,
    kind: target.kind,
    self: target.self,
  });
  const needsYes = target.confirmFiles === true && resolution.reason !== 'self';
  if (resolution.mode === 'allow' && !needsYes) {
    return resolution.reason === 'default' || resolution.reason === 'off' ? 'rule' : resolution.reason;
  }
  if (resolution.mode === 'deny') {
    if (resolution.reason === 'off') throw deniedBySwitch(target);
    throw deniedByPolicy(target, resolution.reason === 'default');
  }

  let reply: AccessReply | null;
  try {
    reply = await gate.port.request({
      account: target.account,
      ...(target.contact === undefined ? {} : { contact: target.contact }),
      kind: target.kind,
      session: gate.session,
      oneShot: gate.oneShot,
      ...(target.preview === undefined ? {} : { preview: target.preview }),
      ...(target.attachments === undefined ? {} : { attachments: target.attachments }),
    });
  } catch (error) {
    throw noDaemon(target, error);
  }
  if (reply === null) throw noDaemon(target);
  if (reply.allowed) return reply.reason;
  throw refusedAfterAsking(target, reply.reason);
}

/** `requireAccess` for every contact of one message or conversation; all of them must pass. */
export async function requireAccessAll(
  gate: AccessGate,
  account: string,
  contacts: readonly string[],
  kind: Kind,
): Promise<void> {
  // No contact known: the account-level rule is all there is to ask about.
  const list: Array<string | undefined> = contacts.length === 0 ? [undefined] : [...new Set(contacts)];
  for (const contact of list) await requireAccess(gate, { account, contact, kind });
}

/**
 * Keep the items an agent may read, never prompting: a search spans contacts, and a prompt per
 * hit would be a flood. An item is kept when every contact resolves to `allow` — by rule, or by a
 * grant of this session, which only the daemon knows and a `probe` asks for. What is not kept is
 * counted, so the caller can say that something was withheld.
 */
export async function filterByAccess<T>(
  gate: AccessGate,
  items: readonly T[],
  pick: (item: T) => { account: string; contacts: readonly string[] },
): Promise<{ kept: T[]; withheld: number }> {
  const memo = new Map<string, boolean>();
  const allowed = async (account: string, contact: string | undefined): Promise<boolean> => {
    const key = JSON.stringify([account, contact ?? null]);
    const known = memo.get(key);
    if (known !== undefined) return known;
    const resolution = resolve(gate.policy, { account, contact, kind: 'read' });
    let ok = resolution.mode === 'allow';
    if (resolution.mode === 'ask') {
      try {
        const reply = await gate.port.request({
          account,
          ...(contact === undefined ? {} : { contact }),
          kind: 'read',
          session: gate.session,
          oneShot: gate.oneShot,
          probe: true,
        });
        ok = reply?.allowed === true;
      } catch {
        ok = false;
      }
    }
    memo.set(key, ok);
    return ok;
  };
  const kept: T[] = [];
  for (const item of items) {
    const { account, contacts } = pick(item);
    const list: Array<string | undefined> = contacts.length === 0 ? [undefined] : [...contacts];
    let pass = true;
    for (const contact of list) {
      if (!(await allowed(account, contact))) {
        pass = false;
        break;
      }
    }
    if (pass) kept.push(item);
  }
  return { kept, withheld: items.length - kept.length };
}

/**
 * The config with an `allow` rule for one request added or widened — what "Always" writes.
 * An existing rule for the same scope keeps what it says about the other kind. Migrated rules are
 * never touched: they already allow both kinds, and saving drops them anyway.
 */
export function withAllowRule(
  config: CurlewConfig,
  target: Pick<AccessTarget, 'account' | 'contact' | 'kind'>,
): CurlewConfig {
  const same = (rule: PolicyRule): boolean =>
    !rule.migrated && rule.account === target.account && rule.contact === target.contact;
  const existing = config.agentAccess.rules.find(same);
  const rules = existing
    ? config.agentAccess.rules.map((rule) => (rule === existing ? { ...rule, [target.kind]: 'allow' } : rule))
    : [
        ...config.agentAccess.rules,
        {
          account: target.account,
          ...(target.contact === undefined ? {} : { contact: target.contact }),
          [target.kind]: 'allow',
        } as PolicyRule,
      ];
  return { ...config, agentAccess: { ...config.agentAccess, rules } };
}
