/**
 * The daemon's side of an agent-access prompt (ADR 0009, step 3).
 *
 * An agent process that meets `ask` sends `RequestAccess` to the daemon; the daemon hands it to
 * this broker. The broker re-resolves with its own fresh policy and the session grants it holds,
 * shows ONE prompt per (session, scope, kind) however many requests wait on it, remembers a Deny
 * for the session so it is not nagged again, and records "for this session" as a temporary grant.
 *
 * Temporary grants and the Deny memory live in this object — daemon memory — and nowhere else.
 *
 * Pure: the prompt (`PromptUi`), the clock and the config writer are injected, so every branch is
 * tested without a bus. The Gio side is `lib/access-notifications.gjs.ts`.
 */

import {
  type AgentAccessPolicy,
  addTemporaryGrant,
  endSession as dropSession,
  expireTemporaryGrants,
  resolve,
  type TemporaryGrant,
} from './agent-access.ts';
import { ACCESS_PROMPT_TIMEOUT_MS, type AccessAsk, type AccessReply } from './access.ts';

/** What the person (or the lack of one) answered. */
export type PromptChoice = 'once' | 'session' | 'always' | 'deny' | 'dismissed' | 'timeout' | 'unavailable';

/** Shows the prompt. It must settle when `signal` aborts (the broker has given up on it). */
export interface PromptUi {
  ask(ask: AccessAsk, signal: AbortSignal): Promise<PromptChoice>;
}

export interface AccessBrokerOptions {
  ui: PromptUi;
  /** The policy as it is NOW: re-read per request, so a rule added by hand applies at once. */
  policy: () => AgentAccessPolicy;
  /** Persist an "Always" rule. A throw is reported and the request still goes through once. */
  addRule: (ask: AccessAsk) => void | Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  /** One line about what happened, for the daemon log. Never carries text or preview. */
  log?: (line: string) => void;
}

interface Pending {
  session: string;
  controller: AbortController;
  reply: Promise<AccessReply>;
}

function scopeKey(session: string, ask: Pick<AccessAsk, 'account' | 'contact' | 'kind'>): string {
  return JSON.stringify([session, ask.account, ask.contact ?? null, ask.kind]);
}

export class AccessBroker {
  private readonly options: AccessBrokerOptions;
  private grants: TemporaryGrant[] = [];
  private readonly denied = new Set<string>();
  private readonly pending = new Map<string, Pending>();

  constructor(options: AccessBrokerOptions) {
    this.options = options;
  }

  /** The live temporary grants, for tests and the log. */
  get temporaryGrants(): readonly TemporaryGrant[] {
    return this.grants;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  /** Answer one request: from the policy and session grants, or by asking. */
  async request(ask: AccessAsk): Promise<AccessReply> {
    this.grants = expireTemporaryGrants(this.grants, this.now());
    const resolution = resolve(this.options.policy(), {
      account: ask.account,
      contact: ask.contact,
      kind: ask.kind,
      temporary: { grants: this.grants, session: ask.session, now: this.now() },
    });
    // A request with files reaches here only when the caller found no reason to skip the question
    // (`confirmFiles`), so a session grant must not skip it either, unless the person allowed files
    // unasked.
    const withFiles = (ask.attachments ?? []).length > 0 && this.options.policy().sendFilesUnasked !== true;
    if (resolution.mode === 'allow' && !withFiles) {
      return {
        allowed: true,
        reason:
          resolution.reason === 'default'
            ? 'rule'
            : resolution.reason === 'self'
              ? 'rule'
              : resolution.reason,
      };
    }
    if (resolution.mode === 'deny') return { allowed: false, reason: 'policy' };
    if (ask.probe) return { allowed: false, reason: 'policy' };

    const key = scopeKey(ask.session, ask);
    if (!ask.oneShot && this.denied.has(key)) return { allowed: false, reason: 'denied-before' };
    const running = this.pending.get(key);
    if (running) return running.reply;

    const controller = new AbortController();
    const entry: Pending = {
      session: ask.session,
      controller,
      reply: this.prompt(ask, controller),
    };
    this.pending.set(key, entry);
    try {
      return await entry.reply;
    } finally {
      this.pending.delete(key);
    }
  }

  private async prompt(ask: AccessAsk, controller: AbortController): Promise<AccessReply> {
    const timeoutMs = this.options.timeoutMs ?? ACCESS_PROMPT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = new Promise<PromptChoice>((resolveAborted) => {
      controller.signal.addEventListener('abort', () => resolveAborted('dismissed'), { once: true });
    });
    const timedOut = new Promise<PromptChoice>((resolveTimeout) => {
      timer = setTimeout(() => {
        resolveTimeout('timeout');
        controller.abort();
      }, timeoutMs);
    });
    let choice: PromptChoice;
    try {
      choice = await Promise.race([
        this.options.ui.ask(ask, controller.signal).catch((): PromptChoice => 'unavailable'),
        timedOut,
        aborted,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
    return this.settle(ask, choice);
  }

  private async settle(ask: AccessAsk, choice: PromptChoice): Promise<AccessReply> {
    const outcome = (what: string): void => this.log(`access ${ask.kind} ${ask.account}: ${what}`);
    switch (choice) {
      case 'once':
        outcome('allowed once');
        return { allowed: true, reason: 'once' };
      case 'session':
        // A one-shot caller has no session to remember: its grant would end with the call.
        if (!ask.oneShot) {
          this.grants = addTemporaryGrant(this.grants, {
            account: ask.account,
            ...(ask.contact === undefined ? {} : { contact: ask.contact }),
            kind: ask.kind,
            session: ask.session,
          });
        }
        outcome('allowed for the session');
        return { allowed: true, reason: ask.oneShot ? 'once' : 'session' };
      case 'always':
        try {
          await this.options.addRule(ask);
          outcome('allowed, rule added');
        } catch (error) {
          outcome(`allowed once, rule not saved (${error instanceof Error ? error.message : String(error)})`);
          return { allowed: true, reason: 'once' };
        }
        return { allowed: true, reason: 'rule' };
      case 'deny':
        if (!ask.oneShot) this.denied.add(scopeKey(ask.session, ask));
        outcome('denied');
        return { allowed: false, reason: 'denied' };
      case 'timeout':
        outcome('no answer in time');
        return { allowed: false, reason: 'timeout' };
      case 'dismissed':
        outcome('dismissed');
        return { allowed: false, reason: 'dismissed' };
      case 'unavailable':
        outcome('prompt not shown');
        return { allowed: false, reason: 'unavailable' };
    }
  }

  /** A session is over (its MCP process left the bus): its grants, its Deny memory and any open prompt go. */
  endSession(session: string): void {
    this.grants = dropSession(this.grants, session);
    for (const key of this.denied) {
      if ((JSON.parse(key) as unknown[])[0] === session) this.denied.delete(key);
    }
    for (const entry of this.pending.values()) {
      if (entry.session === session) entry.controller.abort();
    }
  }
}
