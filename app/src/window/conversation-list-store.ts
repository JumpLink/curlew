/**
 * Reads the conversation list from the local index, read-only like `curlew conversations list`.
 * No index (nothing synced yet) and an index that cannot be read both give an empty list: the
 * window then shows its empty state instead of an error about a file the person never made.
 */

import { configPath, indexDbPath, listConversations, openIndexDb } from '@curlew/store';
import { existsSync } from 'node:fs';

import { loadConfig } from '../core/config.ts';
import { type ListEntry, toEntries } from './conversation-list-model.ts';

const LIST_LIMIT = 500;

export function loadConversationEntries(dbPath = indexDbPath(), cfgPath = configPath()): ListEntry[] {
  if (!existsSync(dbPath)) return [];
  try {
    const db = openIndexDb(dbPath, { busyTimeoutMs: 300 });
    try {
      const { senders, ui } = loadConfig(cfgPath);
      return toEntries(listConversations(db, { limit: LIST_LIMIT, overrides: senders }), ui.showAllEmails);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
