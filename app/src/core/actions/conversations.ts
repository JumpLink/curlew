/**
 * Conversation actions — the per-person view over the local index.
 *
 * Read-only against the index, like `index search`: conversations are built by `curlew sync`.
 * Per-sender corrections go to the config file and apply at read time, so a correction shows
 * immediately and still never writes to the index.
 */

import type { AttachmentKind, Classification, Conversation, ConversationMessage } from '@curlew/protocol';
import { normalizeAddress } from '@curlew/protocol';
import {
  configPath,
  getConversation,
  indexDbPath,
  listConversations,
  loadAttachments,
  syncStatus,
} from '@curlew/store';
import { loadConfig, saveConfig } from '../config.ts';
import { chatOnlyAccountIds, hiddenAccountIds } from '../visibility.ts';
import type { AgentAccess } from './access.ts';
import { requireParticipantsRead } from './message-access.ts';
import { MAX_STALENESS_HOURS, openIndex } from './index-sync.ts';
import { CONVERSATION_BODY_CHARS, CONVERSATION_LIMIT, capLimit } from './limits.ts';

export interface ConversationsListParams {
  peopleOnly?: boolean;
  accountId?: string;
  limit?: number;
  dbPath?: string;
  configPath?: string;
}

export function conversationsList(params: ConversationsListParams = {}): {
  count: number;
  source: 'local-index';
  indexedAt: string | null;
  conversations: Conversation[];
} {
  const config = loadConfig(params.configPath ?? configPath());
  const { senders } = config;
  const db = openIndex(params.dbPath ?? indexDbPath());
  try {
    const conversations = listConversations(db, {
      peopleOnly: params.peopleOnly,
      accountId: params.accountId,
      excludeAccounts: hiddenAccountIds(config),
      chatOnlyAccounts: chatOnlyAccountIds(config),
      limit: capLimit(params.limit, CONVERSATION_LIMIT),
      overrides: senders,
    });
    return {
      count: conversations.length,
      source: 'local-index',
      indexedAt: syncStatus(db, MAX_STALENESS_HOURS, new Date()).newestSync,
      conversations,
    };
  } finally {
    db.close();
  }
}

export interface ConversationShowParams {
  id: string;
  includeBodies?: boolean;
  maxBodyChars?: number;
  /** Only messages sent after this ISO time (or after this message id) — for waiting on a reply. */
  since?: string;
  /** Only messages from the other side. */
  incomingOnly?: boolean;
  /** Set by an agent frontend: bodies are then read only with ADR 0009 `read` access. */
  agent?: AgentAccess;
  dbPath?: string;
  configPath?: string;
}

/**
 * What an agent learns about a chat message's attachment: the kind and size, never the opaque
 * backend handle. The filename is somebody's words, so it follows the body gate.
 */
export interface ShownAttachment {
  index: number;
  kind: AttachmentKind;
  mimeType: string | null;
  size: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  /** `message_save_attachment` can download it. */
  fetchable: boolean;
  filename?: string | null;
}

/** Chat messages list their attachments (mail has `mail_list_parts`). */
export type ShownConversationMessage = ConversationMessage & { attachments?: ShownAttachment[] };

export async function conversationsShow(params: ConversationShowParams): Promise<{
  conversation: Conversation;
  messages: ShownConversationMessage[];
}> {
  const config = loadConfig(params.configPath ?? configPath());
  const { senders } = config;
  const db = openIndex(params.dbPath ?? indexDbPath());
  try {
    const found = getConversation(db, params.id, {
      includeBodies: params.includeBodies,
      maxBodyChars: capLimit(params.maxBodyChars, CONVERSATION_BODY_CHARS),
      overrides: senders,
      since: params.since,
      incomingOnly: params.incomingOnly,
    });
    if (!found) throw new Error(`no conversation with id ${params.id} — run \`curlew conversations list\``);
    if (params.agent && params.includeBodies) {
      const { conversation } = found;
      await requireParticipantsRead(
        config,
        params.agent,
        conversation.accountId,
        conversation.participants.map((p) => p.addresses.map((a) => a.value)),
      );
    }
    const messages: ShownConversationMessage[] = found.messages.map((message) => {
      if (!message.hasAttachments || message.ref.backend === 'mail') return message;
      const attachments = loadAttachments(db, message.ref).map((a) => ({
        index: a.index,
        kind: a.kind,
        mimeType: a.mimeType,
        size: a.size,
        durationMs: a.durationMs,
        width: a.width,
        height: a.height,
        fetchable: a.fetchable,
        ...(params.includeBodies ? { filename: a.filename } : {}),
      }));
      return attachments.length > 0 ? { ...message, attachments } : message;
    });
    return { conversation: found.conversation, messages };
  } finally {
    db.close();
  }
}

/**
 * Correct the classification of one sender, or hand it back to the automatic rules (`auto`).
 * Writes the config, not the index.
 */
export function conversationsClassify(
  address: string,
  as: Classification | 'auto',
  path = configPath(),
): { address: string; classification: Classification | 'auto' } {
  const key = normalizeAddress('email', address);
  if (!key) throw new Error(`${JSON.stringify(address)} is not a mail address`);
  const config = loadConfig(path);
  const senders = { ...config.senders };
  if (as === 'auto') delete senders[key];
  else senders[key] = as;
  saveConfig({ ...config, senders }, path);
  return { address: key, classification: as };
}
