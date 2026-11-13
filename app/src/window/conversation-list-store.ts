/**
 * Reads the conversation list from the local index, read-only like `curlew conversations list`.
 * No index (nothing synced yet) and an index that cannot be read both give an empty list: the
 * window then shows its empty state instead of an error about a file the person never made.
 */

import {
  configPath,
  type IndexDatabase,
  indexDbPath,
  latestMessagePreviews,
  listChatRooms,
  listPeerFeatures,
  listConversations,
  openIndexDb,
  searchMessageText,
} from '@curlew/store';
import { existsSync, statSync } from 'node:fs';

import { loadConfig } from '../core/config.ts';
import { type ListEntry, toEntries, withPreviews } from './conversation-list-model.ts';

// Mail is two orders of magnitude bigger than chat: one shared limit let 480 newsletters push every
// chat but a handful out of the list. Chats are listed whole, mail by its own limit.
const CHAT_LIMIT = 5000;
const MAIL_LIMIT = 500;

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

/**
 * A cheap fingerprint of what the list is built from: the index (a write lands in the WAL file
 * first) and the config. Equal fingerprints mean the list would come out the same, so a caller
 * can skip the half-second load.
 */
export function listStamp(dbPath = indexDbPath(), cfgPath = configPath()): string {
  const part = (path: string): string => {
    try {
      const { mtimeMs, size } = statSync(path);
      return `${mtimeMs}:${size}`;
    } catch {
      return '-';
    }
  };
  return [dbPath, `${dbPath}-wal`, cfgPath].map(part).join('|');
}

export function loadConversationEntries(dbPath = indexDbPath(), cfgPath = configPath()): ListEntry[] {
  if (!existsSync(dbPath)) return [];
  try {
    const db = openIndexDb(dbPath, { busyTimeoutMs: 300 });
    try {
      const { senders, ui, mergedPeople, pins, contactChoices, backends } = loadConfig(cfgPath);
      // Only an explicit `enabled: false` hides a protocol: a config that never mentions one still
      // shows what the index holds, and the person switched this off on purpose.
      const switchedOff = (backend: string): boolean => backends[backend]?.enabled === false;
      const entries = toEntries(
        [
          ...listConversations(db, { limit: CHAT_LIMIT, excludeBackend: 'mail', overrides: senders }),
          ...listConversations(db, {
            limit: MAIL_LIMIT,
            backend: 'mail',
            emailChat: !ui.showAllEmails,
            overrides: senders,
          }),
        ].filter((conversation) => !switchedOff(conversation.backend)),
        ui.showAllEmails,
        accountIdentities(db),
        listChatRooms(db, 'matrix'),
        mergedPeople,
        pins,
        contactChoices,
        listPeerFeatures(db, 'xmpp'),
      );
      // The text of the newest message is read here and kept on the row: the `Conversation` the
      // agents get stays free of other people's words.
      return withPreviews(
        entries,
        latestMessagePreviews(
          db,
          entries.flatMap((e) => e.conversationIds),
        ),
      );
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** Conversation id → a line of message text around the match; empty on no index or a failed read. */
export function searchConversationText(text: string, dbPath = indexDbPath()): Map<string, string> {
  if (!existsSync(dbPath)) return new Map();
  try {
    const db = openIndexDb(dbPath, { busyTimeoutMs: 300 });
    try {
      return new Map(searchMessageText(db, text).map((hit) => [hit.conversationId, hit.snippet]));
    } finally {
      db.close();
    }
  } catch {
    return new Map();
  }
}
