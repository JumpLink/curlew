/**
 * Star a conversation, and keep the network's pin in step (ADR 0020 §§4–6).
 *
 * Same road as `mute.ts`: the local flag first, the push second. A network that has no pin left is
 * not asked again and nothing else is unpinned for it: the star stays in curlew, and the caller
 * hears `full` once so it can say so.
 */

import { asChatPinLimit } from '@curlew/protocol';
import {
  type IndexDatabase,
  applyRemoteFavourite,
  clearFlagPending,
  configPath,
  setChatFavourite,
} from '@curlew/store';
import { loadConfig } from '../config.ts';
import type { WriteFrontend } from '../write-log.ts';
import { type PushChatFlagsParams, pushChatFlags } from './chat-flags.ts';
import { chatFlagsAllowed } from './mute.ts';

/** `full` = the network's pins are used up: starred in curlew only, `limit` is its number if known. */
export type SetFavouriteOutcome =
  | { kind: 'pushed' | 'local' | 'off' | 'failed' }
  | { kind: 'full'; limit: number | null };

export interface SetConversationFavouriteParams extends Pick<
  PushChatFlagsParams,
  'accountId' | 'to' | 'dbPath' | 'configPath' | 'writeLogPath' | 'backend' | 'daemon'
> {
  db: IndexDatabase;
  conversationId: string;
  favourite: boolean;
  frontend: WriteFrontend;
}

export async function setConversationFavourite(
  params: SetConversationFavouriteParams,
): Promise<SetFavouriteOutcome> {
  const config = loadConfig(params.configPath ?? configPath());
  const sync = chatFlagsAllowed(config);
  if (!setChatFavourite(params.db, params.conversationId, { favourite: params.favourite, pending: sync })) {
    return { kind: 'local' };
  }
  if (!sync) return { kind: 'off' };
  try {
    const outcome = await pushChatFlags({
      accountId: params.accountId,
      to: params.to,
      favourite: params.favourite,
      frontend: params.frontend,
      ...(params.dbPath === undefined ? {} : { dbPath: params.dbPath }),
      ...(params.configPath === undefined ? {} : { configPath: params.configPath }),
      ...(params.writeLogPath === undefined ? {} : { writeLogPath: params.writeLogPath }),
      ...(params.backend === undefined ? {} : { backend: params.backend }),
      ...(params.daemon === undefined ? {} : { daemon: params.daemon }),
    });
    clearFlagPending(params.db, params.conversationId, 'favourite');
    return { kind: outcome === 'pushed' ? 'pushed' : 'local' };
  } catch (error) {
    const full = asChatPinLimit(error);
    if (full !== null) {
      clearFlagPending(params.db, params.conversationId, 'favourite');
      // The network has no pin for it: remember that, so its next report of "not pinned" is no news.
      applyRemoteFavourite(params.db, params.conversationId, false, { apply: false });
      return { kind: 'full', limit: full.limit };
    }
    console.warn(
      `curlew: favourite not pushed for ${params.accountId}: ${error instanceof Error ? error.message : error}`,
    );
    return { kind: 'failed' };
  }
}
