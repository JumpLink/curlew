/**
 * Mute a conversation, and keep the network's mute in step (ADR 0020 §§4–5).
 *
 * The local flag is written first and is what the window shows; the push to the network is the
 * second half. A push that fails leaves the flag pending, so the next sync resolves it by the
 * rule in §4 instead of the person seeing a mute that did not stick.
 */

import {
  type IndexDatabase,
  clearFlagPending,
  loadChatFlags,
  setChatMuted,
  type ChatAccountSyncResult,
} from '@curlew/store';
import { configPath } from '@curlew/store';
import { loadConfig, type CurlewConfig } from '../config.ts';
import type { WriteFrontend } from '../write-log.ts';
import { type PushChatFlagsParams, pushChatFlags } from './chat-flags.ts';

/** `off` = the setting is off: the flag stays local and nothing leaves the machine. */
export type SetMuteOutcome = 'pushed' | 'local' | 'off' | 'failed';

/** Whether a mute may cross to the network under the person's settings. */
export function chatFlagsAllowed(config: CurlewConfig): boolean {
  return config.ui.syncChatFlags !== false;
}

export interface MuteInput {
  muted: boolean;
  /** Absolute instant the mute ends; null = until unmuted. */
  until: string | null;
}

export interface SetConversationMuteParams extends Pick<
  PushChatFlagsParams,
  'accountId' | 'to' | 'dbPath' | 'configPath' | 'writeLogPath' | 'backend' | 'daemon'
> {
  db: IndexDatabase;
  conversationId: string;
  mute: MuteInput;
  frontend: WriteFrontend;
}

export async function setConversationMute(params: SetConversationMuteParams): Promise<SetMuteOutcome> {
  const config = loadConfig(params.configPath ?? configPath());
  const sync = chatFlagsAllowed(config);
  const until = params.mute.muted ? params.mute.until : null;
  if (!setChatMuted(params.db, params.conversationId, { muted: params.mute.muted, until, pending: sync })) {
    return 'local';
  }
  if (!sync) return 'off';
  try {
    const outcome = await pushChatFlags({
      accountId: params.accountId,
      to: params.to,
      mute: { muted: params.mute.muted, until },
      frontend: params.frontend,
      ...(params.dbPath === undefined ? {} : { dbPath: params.dbPath }),
      ...(params.configPath === undefined ? {} : { configPath: params.configPath }),
      ...(params.writeLogPath === undefined ? {} : { writeLogPath: params.writeLogPath }),
      ...(params.backend === undefined ? {} : { backend: params.backend }),
      ...(params.daemon === undefined ? {} : { daemon: params.daemon }),
    });
    clearFlagPending(params.db, params.conversationId, 'mute');
    return outcome === 'pushed' ? 'pushed' : 'local';
  } catch (error) {
    console.warn(
      `curlew: mute not pushed for ${params.accountId}: ${error instanceof Error ? error.message : error}`,
    );
    return 'failed';
  }
}

/**
 * Push once more the mutes a sync found the network contradicting (`flagRetries`). The mark is
 * cleared either way, so the next sync settles the flag by the rule and never retries twice. `to` is the chat's id as the account's sync knows it.
 */
export async function retryMutePushes(
  db: IndexDatabase,
  accounts: readonly ChatAccountSyncResult[],
  push: Pick<PushChatFlagsParams, 'dbPath' | 'configPath' | 'writeLogPath' | 'backend' | 'daemon'> = {},
): Promise<number> {
  const config = loadConfig(push.configPath ?? configPath());
  if (!chatFlagsAllowed(config)) return 0;
  let retried = 0;
  for (const account of accounts) {
    for (const conversationId of account.flagRetries ?? []) {
      const flags = loadChatFlags(db, conversationId);
      const cursor = db
        .prepare('SELECT chat_id FROM chat_cursors WHERE conversation_id = ?')
        .get(conversationId) as { chat_id?: unknown } | undefined;
      if (flags === null || cursor?.chat_id === undefined) continue;
      if (flags.mutePendingAt === null && flags.favouritePendingAt === null) continue;
      try {
        const outcome = await pushChatFlags({
          ...push,
          accountId: account.accountId,
          to: String(cursor.chat_id),
          ...(flags.mutePendingAt === null ? {} : { mute: { muted: flags.muted, until: flags.mutedUntil } }),
          ...(flags.favouritePendingAt === null ? {} : { favourite: flags.favourite }),
          frontend: 'cli',
        });
        // The network's answer to this second push arrives with the next sync, which then
        // settles the flag by the rule instead of retrying again.
        if (outcome === 'pushed') retried++;
        clearFlagPending(db, conversationId, 'mute');
        clearFlagPending(db, conversationId, 'favourite');
      } catch (error) {
        clearFlagPending(db, conversationId, 'mute');
        clearFlagPending(db, conversationId, 'favourite');
        console.warn(
          `curlew: mute retry failed for ${conversationId}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  return retried;
}
