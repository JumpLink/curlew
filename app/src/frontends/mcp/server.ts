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
import { applyGrantGate, serveStdio } from '@gjsify/mcp';
import { configPath, envValue } from '@curlew/store';

import { loadConfig } from '../../core/config.ts';

import { registerAccountsTools } from './tools/accounts.ts';
import { registerCalendarTools } from './tools/calendar.ts';
import { registerContactsTools } from './tools/contacts.ts';
import { registerConversationTools } from './tools/conversations.ts';
import { registerGateCanary } from './tools/gate-canary.ts';
import { registerIndexTools } from './tools/index-sync.ts';
import { registerMailTools } from './tools/mail.ts';
import { registerOmemoTools } from './tools/omemo.ts';
import { registerSendTools } from './tools/send.ts';
import { registerSetupTools } from './tools/setup.ts';

const SERVER_NAME = 'curlew';
const SERVER_VERSION = '0.2.0';

/** Every registrar, in the order their tools should appear. */
const REGISTRARS: Array<(server: McpServer) => void> = [
  registerMailTools,
  registerIndexTools,
  registerConversationTools,
  registerContactsTools,
  registerCalendarTools,
  registerAccountsTools,
  registerOmemoTools,
  // The only registrar with a mutating tool in it: `setup_status` is read-only and always
  // served, `setup_run` is dropped unless CURLEW_MCP_ALLOW_WRITE=1. Both identify themselves by
  // their own annotation, which is the only thing the gate reads.
  registerSetupTools,
  // Needs an xmpp.send grant: without one the gate drops it and the server is read-only.
  registerSendTools,
  // Last, and normally a no-op: a deliberately MUTATING tool that the gate must drop. It is the
  // only thing in this list that can tell a working gate from an absent one — see gate-canary.ts.
  registerGateCanary,
];

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const allowWrite = envValue(process.env, 'MCP_ALLOW_WRITE') === '1';
  // `setup_run` is gated by the env switch, not by a grant, and the two gates do not stack (each
  // wraps registerTool). With the switch on, the setup tools are registered before the grant
  // gate exists; the grant gate then judges everything else, so a granted write still needs its
  // grant and nothing else becomes reachable through the switch.
  if (allowWrite) registerSetupTools(server);
  // Before any other registration — the gate works by wrapping registerTool. Fails CLOSED: a tool
  // without a readOnlyHint or an ungranted capability goes missing from `tools/list`.
  applyGrantGate(server, loadConfig(configPath()).grants);
  for (const register of REGISTRARS) {
    if (allowWrite && register === registerSetupTools) continue;
    register(server);
  }
  return server;
}

/** Start the stdio server and serve until the client disconnects. Does not return. */
export async function startMcpServer(): Promise<void> {
  await serveStdio(createMcpServer(), SERVER_NAME);
}
