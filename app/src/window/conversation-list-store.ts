/**
 * Reads the conversation list from the local index, read-only like `curlew conversations list`.
 * No index (nothing synced yet) and an index that cannot be read both give an empty list: the
 * window then shows its empty state instead of an error about a file the person never made.
 */

import {
  configPath,
  type IndexDatabase,
  indexDbPath,
  listChatRooms,
  listConversations,
  openIndexDb,
} from '@curlew/store';
import { existsSync } from 'node:fs';

import { loadConfig } from '../core/config.ts';
import { type ListEntry, toEntries } from './conversation-list-model.ts';

const LIST_LIMIT = 500;

/**
 * Account id → the address the account is known by, for recognising the chat with oneself: the
 * stored own address when the backend wrote one (WhatsApp, whose identity is a display name),
 * else the identity.
 */
function accountIdentities(db: IndexDatabase): Map<string, string> {
  const rows = db.prepare('SELECT id, identity, address FROM accounts').all() as Array<{
    id: string;
    identity: string | null;
    address: string | null;
  }>;
  const known = rows.map((r) => [r.id, r.address?.trim() || r.identity?.trim() || ''] as const);
  return new Map(known.filter(([, value]) => value !== ''));
}

export function loadConversationEntries(dbPath = indexDbPath(), cfgPath = configPath()): ListEntry[] {
  if (!existsSync(dbPath)) return [];
  try {
    const db = openIndexDb(dbPath, { busyTimeoutMs: 300 });
    try {
      const { senders, ui, mergedPeople, pins } = loadConfig(cfgPath);
      return toEntries(
        listConversations(db, { limit: LIST_LIMIT, overrides: senders }),
        ui.showAllEmails,
        accountIdentities(db),
        listChatRooms(db, 'matrix'),
        mergedPeople,
        pins,
      );
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
