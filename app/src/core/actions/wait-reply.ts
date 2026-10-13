/**
 * `xmpp_wait_reply` — block until the other side answers, or the timeout passes.
 *
 * Reads the local index only (no write, no grant): `curlew daemon` is what puts a reply there, so
 * without a running daemon this times out. The cursor is an ISO time — the `sentAt` of the
 * message sent, or the `cursor` of the previous answer — and only messages strictly newer count.
 * Each message carries `replyToId`: the id its `<reply>` (XEP-0461) names, or null. For a direct chat
 * that is the `originId` that `send_message` returned, which is how a caller tells what was answered.
 */

import type { ConversationMessage } from '@curlew/protocol';
import { chatConversationId, configPath, getConversation, indexDbPath } from '@curlew/store';
import { loadConfig } from '../config.ts';
import { openIndex } from './index-sync.ts';

export const WAIT_TIMEOUT_S = { default: 30, max: 120 } as const;
const POLL_MS = 500;

export interface WaitReplyParams {
  accountId: string;
  /** The peer's bare address. */
  peer: string;
  /** ISO 8601 cursor: only messages sent after it. */
  after: string;
  timeoutS?: number;
  includeBodies?: boolean;
  /** Only messages whose XEP-0461 reply names this id (the `originId` send_message returned). */
  replyTo?: string;
  dbPath?: string;
  configPath?: string;
  /** Injected by tests. */
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/** An incoming message, with the id of the message it answers. */
export type WaitReplyMessage = Omit<ConversationMessage, 'replyToClientId'> & { replyToId: string | null };

export interface WaitReplyResult {
  status: 'reply' | 'timeout';
  conversationId: string;
  messages: WaitReplyMessage[];
  /** Pass as `after` to the next call. */
  cursor: string;
}

export async function waitReply(params: WaitReplyParams): Promise<WaitReplyResult> {
  if (Number.isNaN(Date.parse(params.after))) throw new Error('after must be an ISO 8601 time');
  const timeoutS = Math.min(Math.max(params.timeoutS ?? WAIT_TIMEOUT_S.default, 0), WAIT_TIMEOUT_S.max);
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { senders } = loadConfig(params.configPath ?? configPath());
  const conversationId = chatConversationId('xmpp', params.accountId, params.peer);
  const db = openIndex(params.dbPath ?? indexDbPath());
  const deadline = Date.now() + timeoutS * 1000;
  try {
    for (;;) {
      const found = getConversation(db, conversationId, {
        includeBodies: params.includeBodies ?? true,
        overrides: senders,
        since: params.after,
        incomingOnly: true,
      });
      const messages = (found?.messages ?? [])
        .map(
          ({ replyToClientId, ...rest }): WaitReplyMessage => ({
            ...rest,
            replyToId: replyToClientId ?? null,
          }),
        )
        .filter((m) => params.replyTo === undefined || m.replyToId === params.replyTo);
      if (messages.length > 0) {
        return {
          status: 'reply',
          conversationId,
          messages,
          cursor: messages[messages.length - 1].sentAt ?? params.after,
        };
      }
      if (Date.now() >= deadline || params.signal?.aborted) {
        return { status: 'timeout', conversationId, messages: [], cursor: params.after };
      }
      await sleep(POLL_MS);
    }
  } finally {
    db.close();
  }
}
