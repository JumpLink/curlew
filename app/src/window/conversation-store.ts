/** Read-side adapter between the canonical store threads and the window's contact-chat view. */

import type { ConversationMessage } from '@curlew/protocol';
import {
  configPath,
  getRecentMessages,
  type MessageCursor,
  indexDbPath,
  loadAttachments,
  mailReplyTarget,
  openIndexDb,
  setMessageText,
  setOwnReaction,
  type MailReplyTarget,
} from '@curlew/store';

import { loadConfig } from '../core/config.ts';
import { backendsList } from '../core/actions/backends.ts';
import type { ListEntry } from './conversation-list-model.ts';

import { PAGE_SIZE, type ShownMessage } from './conversation-model.ts';

// The view opens on the newest page of a conversation and reads older ones as it is scrolled up;
// a person with years of mail would otherwise block the main loop while every body is read and
// every bubble is built.
const BODY_LIMIT = 8000;

export function loadConversationMessages(
  entry: ListEntry,
  dbPath = indexDbPath(),
  cfgPath = configPath(),
): ShownMessage[] {
  return loadPage(entry, undefined, dbPath, cfgPath);
}

/** The backends whose manifest says they can send a file: only those get a paperclip. */
export function attachingBackends(cfgPath = configPath()): Set<string> {
  return new Set(
    backendsList(cfgPath)
      .backends.filter((status) => status.capabilities.attachments)
      .map((status) => status.name),
  );
}

/** The backends whose sender can answer one message: only those get a "Reply" entry. */
export function replyingBackends(cfgPath = configPath()): Set<string> {
  return new Set(
    backendsList(cfgPath)
      .backends.filter((status) => status.capabilities.replies)
      .map((status) => status.name),
  );
}

/** The backends that can send a reaction: only those get the emoji row. */
export function reactingBackends(cfgPath = configPath()): Set<string> {
  return new Set(
    backendsList(cfgPath)
      .backends.filter((status) => status.capabilities.reactions)
      .map((status) => status.name),
  );
}

/** The backends whose manifest says they can edit one of the person's own messages. */
export function editingBackends(cfgPath = configPath()): Set<string> {
  return new Set(
    backendsList(cfgPath)
      .backends.filter((status) => status.capabilities.editsOwn)
      .map((status) => status.name),
  );
}

/** The backends whose manifest says they can delete one of the person's own messages. */
export function deletingBackends(cfgPath = configPath()): Set<string> {
  return new Set(
    backendsList(cfgPath)
      .backends.filter((status) => status.capabilities.deletesOwn)
      .map((status) => status.name),
  );
}

/** Keeps the person's reaction in the index, so reopening the chat shows it before any sync does. */
export function recordOwnReaction(messageId: string, emoji: string | null, dbPath = indexDbPath()): void {
  const db = openIndexDb(dbPath, { busyTimeoutMs: 300 });
  try {
    setOwnReaction(db, messageId, emoji);
  } finally {
    db.close();
  }
}

/** Updates a chat message's text in the index, used as a local echo of the person's own edit. */
export function recordOwnEdit(messageId: string, text: string, dbPath = indexDbPath()): void {
  const db = openIndexDb(dbPath, { busyTimeoutMs: 300 });
  try {
    setMessageText(db, messageId, text);
  } finally {
    db.close();
  }
}

/** Removes a chat message from the index, used as a local echo of the person's own deletion. */
export function recordOwnDeletion(messageId: string, dbPath = indexDbPath()): void {
  const db = openIndexDb(dbPath, { busyTimeoutMs: 300 });
  try {
    db.prepare('DELETE FROM conversation_messages WHERE id = ? AND remote_seq IS NOT NULL').run(messageId);
  } finally {
    db.close();
  }
}

/** The page of messages just before `oldest`, the oldest one on screen. */
export function loadOlderMessages(
  entry: ListEntry,
  oldest: MessageCursor,
  dbPath = indexDbPath(),
  cfgPath = configPath(),
): ShownMessage[] {
  return loadPage(entry, oldest, dbPath, cfgPath);
}

function loadPage(
  entry: ListEntry,
  before: MessageCursor | undefined,
  dbPath: string,
  cfgPath: string,
): ShownMessage[] {
  const db = openIndexDb(dbPath, { busyTimeoutMs: 300 });
  try {
    const { senders } = loadConfig(cfgPath);
    const canFetch = new Map(
      backendsList(cfgPath).backends.map((status) => [status.name, status.capabilities.attachmentsRead]),
    );
    const page: ShownMessage[] = getRecentMessages(db, entry.conversationIds, {
      limit: PAGE_SIZE,
      ...(before ? { before } : {}),
      includeBodies: true,
      maxBodyChars: BODY_LIMIT,
      overrides: senders,
    });
    // The parts are metadata only; the bytes are fetched when the person looks at them.
    for (const message of page) {
      if (!message.hasAttachments || message.notice) continue;
      const backendCanFetch = canFetch.get(message.ref.backend) ?? false;
      message.attachments = loadAttachments(db, message.ref).map((a) => ({
        ...a,
        backendCanFetch,
      }));
    }
    return page;
  } finally {
    db.close();
  }
}

export function loadMailReplyTarget(
  message: ConversationMessage | null,
  dbPath = indexDbPath(),
): MailReplyTarget | null {
  if (!message || message.backend !== 'mail') return null;
  const db = openIndexDb(dbPath, { busyTimeoutMs: 300 });
  try {
    return mailReplyTarget(db, message.ref);
  } finally {
    db.close();
  }
}
