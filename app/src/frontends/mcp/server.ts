/**
 * Curlew MCP server — mail, contacts and calendar from GNOME Online Accounts, over stdio.
 *
 * v1 registers read-only tools only, and `applyReadOnlyGate` ENFORCES that rather than trusting
 * it: every tool must carry `readOnlyHint: true` or it is dropped. IMAP is spoken with BODY.PEEK
 * throughout, so even a read never marks a message as seen.
 *
 * The gate, the stdio lifecycle and the uniform tool result come from `@gjsify/mcp` — they were
 * this repo's own `runtime.ts`/`types.ts` until 0.54.0 published them, and troedler carried a
 * verbatim copy meanwhile. What is left here is only which tools this server registers.
 */

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { applyReadOnlyGate, serveStdio } from '@gjsify/mcp';

import { registerAccountsTools } from './tools/accounts.ts';
import { registerCalendarTools } from './tools/calendar.ts';
import { registerContactsTools } from './tools/contacts.ts';
import { registerConversationTools } from './tools/conversations.ts';
import { registerGateCanary } from './tools/gate-canary.ts';
import { registerIndexTools } from './tools/index-sync.ts';
import { registerMailTools } from './tools/mail.ts';
import { registerSetupTools } from './tools/setup.ts';

const SERVER_NAME = 'curlew';
const SERVER_VERSION = '0.1.0';

/** Every registrar, in the order their tools should appear. */
const REGISTRARS: Array<(server: McpServer) => void> = [
  registerMailTools,
  registerIndexTools,
  registerConversationTools,
  registerContactsTools,
  registerCalendarTools,
  registerAccountsTools,
  // The only registrar with a mutating tool in it: `setup_status` is read-only and always
  // served, `setup_run` is dropped unless POSTBOTE_MCP_ALLOW_WRITE=1. Both identify themselves by
  // their own annotation, which is the only thing the gate reads.
  registerSetupTools,
  // Last, and normally a no-op: a deliberately MUTATING tool that the gate must drop. It is the
  // only thing in this list that can tell a working gate from an absent one — see gate-canary.ts.
  registerGateCanary,
];

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  // Before any registration — the gate works by wrapping registerTool, so anything registered
  // earlier would slip past it. It fails CLOSED: a tool whose author forgot the annotation goes
  // missing from `tools/list`, which gets noticed, instead of a mutation being quietly reachable.
  applyReadOnlyGate(server, process.env.POSTBOTE_MCP_ALLOW_WRITE === '1');
  for (const register of REGISTRARS) register(server);
  return server;
}

/** Start the stdio server and serve until the client disconnects. Does not return. */
export async function startMcpServer(): Promise<void> {
  await serveStdio(createMcpServer(), SERVER_NAME);
}
