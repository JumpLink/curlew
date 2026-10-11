/**
 * Conversation tools — the per-person view over the local index, offline.
 *
 * Same privacy split as the mail tools: `conversations_list` cannot return a body at all, and
 * `conversations_get` returns bodies only when `include_bodies` is set, capped per message.
 * Everything here is other people's words; the default answer is who, when and what about.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpSuccess } from '@gjsify/mcp';
import { z } from 'zod';

import {
  CONVERSATION_BODY_CHARS,
  CONVERSATION_LIMIT,
  conversationsList,
  conversationsShow,
  WAIT_TIMEOUT_S,
  waitReply,
} from '../../../core/actions/index.ts';
import { mcpErrorFrom } from '../types.ts';

export function registerConversationTools(server: McpServer): void {
  server.registerTool(
    'conversations_list',
    {
      title: 'List Conversations (offline)',
      description:
        'List conversations from the local index, newest first, across every enabled backend: mail threads grouped by Message-ID/References and chats (e.g. Telegram direct chats, groups, channels). Each has its backend, participants (typed addresses — email, phone, telegram, … — and the linked address-book contact), message and unread counts, and a classification — conversational (a person) or automated (lists, notifications, no-reply, broadcast channels, bots). Set people_only to hide automated ones. No message bodies. Built by `curlew sync`; check mail_sync_status when the list looks incomplete.',
      inputSchema: {
        people_only: z.boolean().optional().describe('Only conversations with a person in them'),
        account_id: z.string().optional().describe('Restrict to one account id'),
        limit: z
          .number()
          .int()
          .positive()
          .max(CONVERSATION_LIMIT.max)
          .optional()
          .describe(
            `Max conversations (default ${CONVERSATION_LIMIT.default}, max ${CONVERSATION_LIMIT.max})`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return mcpSuccess(
          conversationsList({
            peopleOnly: params.people_only,
            accountId: params.account_id,
            limit: params.limit,
          }),
        );
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );

  server.registerTool(
    'conversations_get',
    {
      title: 'Get One Conversation (offline)',
      description:
        'One conversation from the local index with its messages, oldest first: sender, date, subject, presentation (bubble for chat, document for mail), classification with its reason, and a ref — for mail (account, folder, uid), which mail_get_message accepts for the full message; for chats the network message id (remoteId), plus edit time, reply and thread ids and, on your own messages, whether the other side has read them. Bodies are omitted unless include_bodies is true, and then capped per message.',
      inputSchema: {
        id: z.string().min(1).describe('Conversation id from conversations_list'),
        include_bodies: z.boolean().optional().describe('Include each message body (default false)'),
        since: z
          .string()
          .optional()
          .describe(
            'Only messages sent after this ISO 8601 time — pass the sentAt that send_message returned to wait for a reply',
          ),
        incoming_only: z.boolean().optional().describe('Only messages from the other side (default false)'),
        max_body_chars: z
          .number()
          .int()
          .positive()
          .max(CONVERSATION_BODY_CHARS.max)
          .optional()
          .describe(
            `Per-message body cap (default ${CONVERSATION_BODY_CHARS.default}, max ${CONVERSATION_BODY_CHARS.max})`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return mcpSuccess(
          conversationsShow({
            id: params.id,
            includeBodies: params.include_bodies,
            maxBodyChars: params.max_body_chars,
            since: params.since,
            incomingOnly: params.incoming_only,
          }),
        );
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );

  server.registerTool(
    'xmpp_wait_reply',
    {
      title: 'Wait for a Reply (XMPP)',
      description: `Block up to timeout_s (default ${WAIT_TIMEOUT_S.default}, max ${WAIT_TIMEOUT_S.max}) for the next incoming message from one peer, newer than the cursor \`after\`. Pass the sentAt that send_message returned; for the next wait pass the cursor of the previous answer. Returns status "reply" with the messages, or "timeout" with an unchanged cursor — then call again or stop. Reads the local index, which \`curlew daemon\` fills within seconds; without a running daemon it always times out. Each message has \`replyToId\`: the id its XEP-0461 reply names (null when it is not a reply). Compare it with the \`originId\` that send_message returned to see which sent message was answered. Read-only.`,
      inputSchema: {
        account: z.string().min(1).describe('XMPP account id'),
        peer: z.string().min(1).describe('The peer bare address, as used in send_message'),
        after: z.string().min(1).describe('ISO 8601 cursor: only messages sent after it'),
        timeout_s: z.number().min(0).max(WAIT_TIMEOUT_S.max).optional().describe('Seconds to wait'),
        include_bodies: z.boolean().optional().describe('Include message text (default true)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return mcpSuccess(
          await waitReply({
            accountId: params.account,
            peer: params.peer,
            after: params.after,
            timeoutS: params.timeout_s,
            includeBodies: params.include_bodies,
          }),
        );
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );
}
