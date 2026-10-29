/**
 * OMEMO tools — the device keys of one XMPP account, read from its local file.
 *
 * Read-only on purpose, and there is no companion that writes: deciding that a fingerprint
 * belongs to the person you think it does is a human's job, done out of band, and a tool that
 * could mark a key verified would let a crafted message hand over the conversation (ADR 0006 §6).
 * Trust is changed with `curlew omemo` at a terminal or not at all.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpSuccess } from '@gjsify/mcp';
import { z } from 'zod';

import { omemoDevices } from '../../../core/actions/index.ts';
import { mcpErrorFrom } from '../types.ts';

export function registerOmemoTools(server: McpServer): void {
  server.registerTool(
    'omemo_devices',
    {
      title: 'List OMEMO Devices (offline)',
      description:
        "The OMEMO device keys one XMPP account holds: this curlew's own device id and fingerprint, and per contact device the fingerprint (64 hex characters, plus the grouped form used when reading one aloud), its trust state — blind (accepted unchecked, BTBV), verified or distrusted by a person, or undecided and waiting for one — when it was first seen and whether a session with it exists. Read from the local account file, so it answers offline and shows the devices this client has actually talked to, not everything a server advertises. No key material and no message content. Trust can only be changed at a terminal with `curlew omemo`.",
      inputSchema: {
        account_id: z.string().min(1).describe('The xmpp account id from accounts_list'),
        jid: z.string().optional().describe('Only this contact; every known address when omitted'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return mcpSuccess(
          await omemoDevices({
            accountId: params.account_id,
            ...(params.jid === undefined ? {} : { jid: params.jid }),
          }),
        );
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );
}
