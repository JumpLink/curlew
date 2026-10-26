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
import { MESSAGE_FORMATS } from '../../../core/markdown.ts';
import { mcpErrorFrom } from '../types.ts';

export function registerSendTools(server: McpServer): void {
  server.registerTool(
    'send_message',
    requiresCapability(
      {
        title: 'Send a Chat Message',
        description:
          'Send a plain-text chat message and/or one image from a granted XMPP account to one address. Only available when the config grants xmpp.send, and only to the exact account/address pair granted. `format` is `plain` (default: text sent exactly as given, max 8000 characters) or `markdown` (the text is Markdown: rendered as XEP-0393 message styling, a line that is only `![alt](https://…)` becomes its own image message, and texts over 7000 characters are split into several messages; the result then has `parts` and `originIds`, and `originId` is the first message). See messaging_capabilities. Not end-to-end encrypted (OMEMO is not supported). An image is `image_url` (https only): it goes out as its own message after the text, body = the URL plus an XEP-0066 `jabber:x:oob` reference, so Conversations, Gajim and Monocles show it inline; it is not uploaded or fetched by curlew. Returns conversationId, sentAt, originId (and imageOriginId when text and image were both sent) (the stanza id and XEP-0359 origin-id, which a reply references in `replyToId` of xmpp_wait_reply): to wait for the reply, poll conversations_get with id=conversationId, since=sentAt, incoming_only=true, include_bodies=true while `curlew daemon` runs.',
        inputSchema: {
          account: z.string().min(1).describe('XMPP account id from accounts_list'),
          to: z.string().min(1).describe('Bare address, spelled exactly as in the grant'),
          text: z
            .string()
            .min(1)
            .optional()
            .describe('The message (Markdown when format is markdown). Required unless image_url is given'),
          image_url: z
            .string()
            .min(1)
            .optional()
            .describe('https URL of one image, sent as its own message after the text'),
          format: z
            .enum(MESSAGE_FORMATS)
            .optional()
            .describe('plain (default) or markdown (rendered per protocol, long texts split)'),
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
          await sendMessage({
            accountId: params.account,
            to: params.to,
            text: params.text,
            imageUrl: params.image_url,
            format: params.format,
            frontend: 'mcp',
          }),
        );
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );
}
