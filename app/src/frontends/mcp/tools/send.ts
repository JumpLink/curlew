/**
 * `send_message` — the granted send tool (ADR 0004 §3/§4, amended 2026-10-30).
 *
 * It declares its capability through `requiresCapability`; the grant gate registers it only when
 * at least one `<backend>.send` grant exists and checks `<account>/<to>` against the grants on
 * every call before this handler runs. The action checks the same grant again — naming the exact
 * backend — so the CLI and this tool cannot drift.
 *
 * **The gate takes ONE capability per tool, and sending is granted per backend.** So the tool is
 * gated by the union of the send grants under one internal name, `SEND_GATE_CAPABILITY`, which
 * `parseGrants` rejects in a config: it exists for this registration and nothing else. What the
 * gate checks is therefore "this account/address pair is granted for sending somewhere"; the
 * action then checks `<backend>.send` for the pair, and that is the decision.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpSuccess, requiresCapability } from '@gjsify/mcp';
import type { Grant } from '../../../core/grants.ts';
import { isSendCapability } from '../../../core/grants.ts';
import { z } from 'zod';

import { sendMessage, sendTarget } from '../../../core/actions/index.ts';
import { MESSAGE_FORMATS } from '../../../core/markdown.ts';
import { mcpErrorFrom } from '../types.ts';

/**
 * The internal capability the send tool is gated by: one name for every `<backend>.send` grant.
 * Not in `CAPABILITIES`, so it cannot be written into a configuration.
 */
export const SEND_GATE_CAPABILITY = 'send';

/** The gate's grant set: the real grants, plus every `*.send` grant under {@link SEND_GATE_CAPABILITY}. */
export function withSendGateGrants(grants: readonly Grant[]): Array<{ capability: string; target: string }> {
  const union = grants
    .filter((grant) => isSendCapability(grant.capability))
    .map((grant) => ({ capability: SEND_GATE_CAPABILITY, target: grant.target }));
  return [...grants, ...union];
}

export function registerSendTools(server: McpServer): void {
  server.registerTool(
    'send_message',
    requiresCapability(
      {
        title: 'Send a Message',
        description:
          "Send one plain-text message from a granted account. The account picks the backend (mail, XMPP); only available when the config grants that backend's `<backend>.send` for the exact account/address pair. `subject` is mail only. For XMPP, `format` is `plain` (default: text sent exactly as given, max 8000 characters) or `markdown` (rendered as XEP-0393 message styling, a line that is only `![alt](https://…)` becomes its own image message, and texts over 7000 characters are split into several messages; the result then has `parts` and `originIds`, and `originId` is the first message), and an image is `image_url` (https only): it goes out as its own message after the text, body = the URL plus an XEP-0066 `jabber:x:oob` reference, so Conversations, Gajim and Monocles show it inline; it is not uploaded or fetched by curlew. For XMPP the answer carries `conversationId`, `sentAt` and `originId` (the stanza id and XEP-0359 origin-id, which a reply references in `replyToId` of xmpp_wait_reply): to wait for the reply, poll conversations_get with id=conversationId, since=sentAt, incoming_only=true, include_bodies=true while `curlew daemon` runs. For mail only `sentAt` and the message id are meaningful. See messaging_capabilities. Not end-to-end encrypted on XMPP (OMEMO is not supported).",
        inputSchema: {
          account: z
            .string()
            .min(1)
            .describe('Account id from accounts_list, exactly as the grant spells it'),
          to: z.string().min(1).describe('Address, spelled exactly as in the grant'),
          text: z
            .string()
            .min(1)
            .optional()
            .describe('The message (Markdown when format is markdown). Required unless image_url is given'),
          subject: z.string().min(1).optional().describe('Mail only: the subject line'),
          image_url: z
            .string()
            .min(1)
            .optional()
            .describe('XMPP only: https URL of one image, sent as its own message after the text'),
          format: z
            .enum(MESSAGE_FORMATS)
            .optional()
            .describe('XMPP: plain (default) or markdown (rendered per protocol, long texts split)'),
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      {
        capability: SEND_GATE_CAPABILITY,
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
            subject: params.subject,
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
