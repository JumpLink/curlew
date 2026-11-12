/**
 * The agent side of ADR 0009 for the actions: who is asking, and the gate built for one call.
 *
 * An action that serves an AGENT takes an `AgentAccess` and calls `agentGate`; one that serves the
 * person (the GTK app, the daemon's bus send) takes none, and nothing here runs. That is the whole
 * switch between the two paths of ADR 0008 — it is explicit at every call site on purpose, because
 * a gate that defaults to "on" would also gate the person and one that defaults to "off" would
 * leave a forgotten agent path open; the MCP tools and the agent CLI commands always pass it.
 */

import type { Kind } from '../agent-access.ts';
import {
  type AccessGate,
  type AccessPort,
  type AgentFrontend,
  filterByAccess,
  requireAccess,
  requireAccessAll,
} from '../access.ts';
import { type CurlewConfig, effectiveAgentAccess } from '../config.ts';
import { gioAccessClient } from '../lib/daemon-access-client.ts';

export interface AgentAccess {
  frontend: AgentFrontend;
  /** Defaults to this process's id: one MCP server is one session, one CLI call is its own. */
  session?: string;
  /** Injected by tests; the default asks the daemon over the session bus. */
  port?: AccessPort;
  /** Injected by tests: whether an address is the account's own. The default asks the backend. */
  isSelf?: (account: string, address: string) => Promise<boolean>;
}

let mcpSession: string | undefined;

/** The session id of this process for a frontend. Stable for the life of an MCP server. */
export function agentSessionId(frontend: AgentFrontend): string {
  if (frontend === 'cli') return `cli-${process.pid}`;
  mcpSession ??= `mcp-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return mcpSession;
}

export function agentGate(
  config: Pick<CurlewConfig, 'agentAccess' | 'ui' | 'grants'>,
  agent: AgentAccess,
): AccessGate {
  return {
    policy: effectiveAgentAccess(config),
    port: agent.port ?? gioAccessClient(),
    session: agent.session ?? agentSessionId(agent.frontend),
    // A CLI call is a process of its own: there is no session to grant for.
    oneShot: agent.frontend === 'cli',
  };
}

/** One account/contact/kind, or every contact of a message. Throws an `AccessDeniedError`. */
export async function requireAgentAccess(
  config: Pick<CurlewConfig, 'agentAccess' | 'ui' | 'grants'>,
  agent: AgentAccess,
  account: string,
  contacts: readonly string[],
  kind: Kind,
): Promise<void> {
  await requireAccessAll(agentGate(config, agent), account, contacts, kind);
}

export { filterByAccess, requireAccess };
