/**
 * `send_message` — the send tool (ADR 0004 §3/§4, ADR 0008).
 *
 * Registered outside the grant gate and always served: access is per account and contact (ADR 0009).
 * `sendAsAgent` is the decision on every call — a rule, an address the backend recognises as the
 * person's own, or the daemon's prompt — so the CLI and this tool cannot drift.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpSuccess } from '@gjsify/mcp';
import { z } from 'zod';

import { sendAsAgent } from '../../../core/actions/index.ts';
import { MESSAGE_FORMATS } from '../../../core/markdown.ts';
import { mcpErrorFrom } from '../types.ts';

/** `send` is the seam the tests use to hand the action an injected backend; the server passes none. */
export function registerSendTools(server: McpServer, send: typeof sendAsAgent = sendAsAgent): void {
  server.registerTool(
    'send_message',
    {
      title: 'Send a Message',
      description:
        "Send one plain-text message from an account. The account picks the backend (mail, XMPP, Telegram, Matrix, Signal, WhatsApp). Allowed without asking only to the person's own address (note to self) and where config.agentAccess has a rule allowing `write` for that account/address; a `deny` rule refuses, and otherwise the person is asked through a notification from `curlew daemon` (up to 2 minutes; no daemon or no answer = refused). `subject` is mail only. `attachments`: absolute paths of regular files (a symlink is followed once and its target must be a regular file), at most 10 files, sent under the file's base name. Mail, Telegram, Matrix, XMPP and WhatsApp take them (mail: 20 MB each and 25 MB in total; the chat backends have their own limits, and each file goes out as its own message; on WhatsApp a text up to 1024 characters becomes the caption of the first file, 64 MB per file); Signal refuses them. A send of files (mail and chats alike) is ALWAYS put to the person, even where a rule allows the write, except to the account's own address or where the person switched on config.agentAccess.sendFilesUnasked; the prompt lists the file names, never the paths. For XMPP, `format` is `plain` (default: text sent exactly as given, max 8000 characters) or `markdown` (rendered as XEP-0393 message styling, a line that is only `![alt](https://…)` becomes its own image message, and texts over 7000 characters are split into several messages; the result then has `parts` and `originIds`, and `originId` is the first message), and an image is `image_url` (https only): it goes out as its own message after the text, body = the URL plus an XEP-0066 `jabber:x:oob` reference, so Conversations, Gajim and Monocles show it inline; it is not uploaded or fetched by curlew. For XMPP the answer carries `conversationId`, `sentAt` and `originId` (the stanza id and XEP-0359 origin-id, which a reply references in `replyToId` of xmpp_wait_reply): to wait for the reply, poll conversations_get with id=conversationId, since=sentAt, incoming_only=true, include_bodies=true while `curlew daemon` runs. For Telegram `to` is the chat's id as conversations_list shows it (the user id of a direct chat, the negative id of a group), the text is sent exactly as given (plain only, max 4096 characters, refused rather than split, no image). For Matrix `to` is the room id as conversations_list shows it (`!abc:example.org`), the text is sent exactly as given (plain only, max 32000 bytes of UTF-8, refused rather than split, no image), and a room with end-to-end encryption is refused: curlew cannot encrypt yet and will not put a message into such a room in the clear. For Signal `to` is the recipient's ACI as conversations_list shows a direct chat's id (a phone number is not an address here, and a group is refused), the text is sent exactly as given (plain only, max 2048 bytes of UTF-8, refused rather than split, no image), the own account id sends a note to self, and the send is refused while `curlew daemon` holds that account: both share the encryption state, so only one of them may use it at a time. A `sendWarning` in the answer means the message reached the recipient but the user's own other devices may not show it. For WhatsApp `to` is the chat's id as conversations_list shows a direct chat (`<lid>@lid` or `<phone>@s.whatsapp.net`); a bare phone number, an id with a device suffix (`…:3@…`), a group and a broadcast are refused. The text is sent exactly as given (plain only, max 65536 bytes of UTF-8, refused rather than split, no image; files per `attachments`), the own account's JID sends a note to self, and the send is refused while `curlew daemon` holds that account: WhatsApp allows one connection per linked device, so only one of them may use the session at a time. A `sendWarning` here means the message left curlew but WhatsApp did not acknowledge it in time. For mail only `sentAt` and the message id are meaningful. See messaging_capabilities. Not end-to-end encrypted on XMPP (OMEMO is not supported).",
      inputSchema: {
        account: z.string().min(1).describe('Account id from accounts_list, exactly as the rule spells it'),
        to: z.string().min(1).describe('Address, spelled exactly as in the rule'),
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
        attachments: z
          .array(z.string().min(1))
          .max(10)
          .optional()
          .describe(
            'Absolute paths of files to send (regular files, max 10); not Signal. To a chat the person is always asked first',
          ),
        format: z
          .enum(MESSAGE_FORMATS)
          .optional()
          .describe('XMPP: plain (default) or markdown (rendered per protocol, long texts split)'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        return mcpSuccess(
          await send({
            accountId: params.account,
            to: params.to,
            text: params.text,
            subject: params.subject,
            imageUrl: params.image_url,
            attachments: params.attachments,
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
