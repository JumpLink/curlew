/**
 * `send_message` — the one granted write tool (ADR 0004 §3/§4).
 *
 * It declares its capability through `requiresCapability`; the grant gate registers it only when
 * an `xmpp.send` grant exists and checks `<account>/<to>` against the grants on every call before
 * this handler runs. The action checks the same grant again, so the CLI and this tool cannot
 * drift.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpSuccess, requiresCapability } from '@gjsify/mcp';
import { z } from 'zod';

import { SEND_CAPABILITY, sendMessage, sendTarget } from '../../../core/actions/index.ts';
import { mcpErrorFrom } from '../types.ts';

export function registerSendTools(server: McpServer): void {
  server.registerTool(
    'send_message',
    requiresCapability(
      {
        title: 'Send a Chat Message',
        description:
          'Send one plain-text chat message from a granted XMPP account to one address. Only available when the config grants xmpp.send, and only to the exact account/address pair granted. Not end-to-end encrypted (OMEMO is not supported). Returns conversationId, sentAt and originId (the stanza id and XEP-0359 origin-id, which a reply references in `replyToId` of xmpp_wait_reply): to wait for the reply, poll conversations_get with id=conversationId, since=sentAt, incoming_only=true, include_bodies=true while `curlew daemon` runs.',
        inputSchema: {
          account: z.string().min(1).describe('XMPP account id from accounts_list'),
          to: z.string().min(1).describe('Bare address, spelled exactly as in the grant'),
          text: z.string().min(1).describe('The message, plain text'),
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      {
        capability: SEND_CAPABILITY,
        targetOf: (args: { account: string; to: string }) => sendTarget(args.account, args.to),
      },
    ),
    async (params) => {
      try {
        return mcpSuccess(
          await sendMessage({ accountId: params.account, to: params.to, text: params.text, frontend: 'mcp' }),
        );
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );
}
