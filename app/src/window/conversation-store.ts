/** Read-side adapter between the canonical store threads and the window's contact-chat view. */

import type { ConversationMessage } from '@curlew/protocol';
import {
  configPath,
  getRecentMessages,
  type MessageCursor,
  indexDbPath,
  mailAttachments,
  mailReplyTarget,
  openIndexDb,
  type MailReplyTarget,
} from '@curlew/store';

import { loadConfig } from '../core/config.ts';
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
    const page: ShownMessage[] = getRecentMessages(db, entry.conversationIds, {
      limit: PAGE_SIZE,
      ...(before ? { before } : {}),
      includeBodies: true,
      maxBodyChars: BODY_LIMIT,
      overrides: senders,
    });
    // Only a message that is nothing but attachments needs to say what they are.
    for (const message of page) {
      if (message.hasAttachments && !message.bodyText?.trim() && !message.notice)
        message.attachments = mailAttachments(db, message.ref);
    }
    return page;
  } finally {
    db.close();
  }
}

export function loadMailReplyTarget(message: ConversationMessage | null, dbPath = indexDbPath()): MailReplyTarget | null {
  if (!message || message.backend !== 'mail') return null;
  const db = openIndexDb(dbPath, { busyTimeoutMs: 300 });
  try {
    return mailReplyTarget(db, message.ref);
  } finally {
    db.close();
  }
}
