/**
 * `curlew send` / `send_message` — a plain-text chat message and/or one image from a granted XMPP account.
 *
 * Both frontends call this, and this is where the grant is checked (ADR 0004 §4): the CLI is no
 * back door for an agent with a shell. The grant names `<account>/<address>` exactly; the permit
 * handed to the XMPP session lists only the addresses granted for this account, and the session
 * checks it again on send.
 *
 * An image goes out as its OWN stanza after the text (XEP-0066 practice: a client renders the file
 * inline only when the body is exactly the URL, so a caption cannot share the stanza). Text and
 * image are therefore two stanzas, two origin-ids, two write-log lines and two index rows.
 *
 * Order matters: send, then the write log, then index the outgoing message. Once the server has
 * the message it is sent, whatever happens next: the log line records that, and a failing log is
 * a failed call. Indexing is best effort — a busy or broken index must not report a delivered
 * message as failed, or a caller that retries sends it twice. The daemon's catch-up (carbons,
 * MAM) stores the message later anyway.
 */

import { chatConversationId, configPath, indexDbPath, recordSentChatMessage } from '@curlew/store';
import type { SentChatRecord } from '@curlew/store';
import { validateImageUrl, XmppBackend } from '@curlew/xmpp';
import type { SendPermit, SentChat } from '@curlew/xmpp';
import { builtinRegistry } from '../backends/builtin.ts';
import { backendContext } from '../backends/context.ts';
import { loadConfig, type CurlewConfig } from '../config.ts';
import { type Grant, isGranted } from '../grants.ts';
import { appendWriteLog, type WriteFrontend } from '../write-log.ts';
import { openIndex } from './index-sync.ts';

export const SEND_CAPABILITY = 'xmpp.send';

export interface SendParams {
  accountId: string;
  /** The address exactly as the grant spells it. */
  to: string;
  /** The message text. At least one of `text` and `imageUrl` is required. */
  text?: string;
  /** An https URL sent as its own message (body = URL + XEP-0066 `jabber:x:oob`), shown inline by clients. */
  imageUrl?: string;
  frontend: WriteFrontend;
  dbPath?: string;
  configPath?: string;
  /** Where the write log goes; injected by tests. */
  writeLogPath?: string;
  /** Injected by tests: the backend that opens the granted session. */
  backend?: XmppBackend;
}

export interface SendResult {
  /** The conversation to watch for a reply: `conversations_get { id, since: sentAt, incoming_only }`. */
  conversationId: string;
  /** The indexed row, or null when the message went out but could not be indexed (see `indexError`). */
  messageId: string | null;
  /** Why indexing failed; the message was delivered regardless. */
  indexError?: string;
  chatJid: string;
  /** The text message's id; the image's when only an image was sent. */
  originId: string;
  /** The image message's id when text AND image were sent. */
  imageOriginId?: string;
  /** Local clock, ISO 8601: pass it as `since` when waiting for the reply. */
  sentAt: string;
}

/** The grant target of an `xmpp.send` pair. */
export function sendTarget(accountId: string, to: string): string {
  return `${accountId}/${to}`;
}

/** The addresses the grants allow for one account — what the session's permit lists. */
export function permitFor(grants: readonly Grant[], accountId: string): SendPermit {
  const prefix = `${accountId}/`;
  return {
    account: accountId,
    addresses: grants
      .filter((g) => g.capability === SEND_CAPABILITY && g.target.startsWith(prefix))
      .map((g) => g.target.slice(prefix.length)),
  };
}

/** Throw unless the grants name exactly this pair. */
export function requireSendGrant(config: Pick<CurlewConfig, 'grants'>, accountId: string, to: string): void {
  if (!isGranted(config.grants, SEND_CAPABILITY, sendTarget(accountId, to))) {
    throw new Error(
      `${SEND_CAPABILITY} is not granted for ${sendTarget(accountId, to)} — add { "capability": "${SEND_CAPABILITY}", "target": "${sendTarget(accountId, to)}" } to the grants in the config file`,
    );
  }
}

/** The registry's xmpp backend, typed for its granted handle. */
export function createXmppBackend(config: CurlewConfig): XmppBackend {
  const created = builtinRegistry().create(config, 'xmpp', backendContext('xmpp', config));
  if (!(created instanceof XmppBackend)) throw new Error('the xmpp backend is not available');
  return created;
}

export async function sendMessage(params: SendParams): Promise<SendResult> {
  const config = loadConfig(params.configPath ?? configPath());
  requireSendGrant(config, params.accountId, params.to);
  const text = params.text !== undefined && params.text.trim().length > 0 ? params.text : undefined;
  if (text === undefined && params.imageUrl === undefined)
    throw new Error('nothing to send: give text, an image URL or both');
  // Validated before anything is sent, so a bad URL cannot leave the text half-delivered.
  const imageUrl = params.imageUrl === undefined ? undefined : validateImageUrl(params.imageUrl);
  const backend = params.backend ?? createXmppBackend(config);
  const account = (await backend.listAccounts()).find((a) => a.id === params.accountId);
  if (!account) throw new Error(`no xmpp account ${params.accountId} — \`curlew accounts list\` shows them`);

  const session = await backend.openGranted(params.accountId, permitFor(config.grants, params.accountId));
  const sends: Array<{ sent: SentChat; body: string }> = [];
  try {
    if (text !== undefined) sends.push({ sent: await session.send(params.to, text), body: text });
    if (imageUrl !== undefined)
      sends.push({ sent: await session.sendImage(params.to, imageUrl), body: imageUrl });
  } finally {
    await session.close().catch(() => {});
  }

  const dbPath = params.dbPath ?? indexDbPath();
  const recorded = sends.map(({ sent, body }) => {
    appendWriteLog(
      {
        capability: SEND_CAPABILITY,
        target: sendTarget(params.accountId, params.to),
        frontend: params.frontend,
        id: sent.originId,
      },
      { path: params.writeLogPath },
    );
    return recordDelivered(dbPath, account, {
      chatJid: sent.chatJid,
      originId: sent.originId,
      text: body,
      sentAt: sent.sentAt,
    });
  });
  const first = sends[0].sent;
  return {
    ...recorded[0],
    chatJid: first.chatJid,
    originId: first.originId,
    ...(sends.length > 1 ? { imageOriginId: sends[1].sent.originId } : {}),
    sentAt: first.sentAt,
  };
}

/** Index a delivered message. Never throws: the message is out, so a failure here is only reported. */
export function recordDelivered(
  dbPath: string,
  account: SentChatRecord['account'],
  sent: { chatJid: string; originId: string; text: string; sentAt: string },
): { conversationId: string; messageId: string | null; indexError?: string } {
  try {
    const db = openIndex(dbPath);
    try {
      return recordSentChatMessage(db, {
        backend: 'xmpp',
        account,
        chatRemoteId: sent.chatJid,
        clientId: sent.originId,
        text: sent.text,
        sentAt: sent.sentAt,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      conversationId: chatConversationId('xmpp', account.id, sent.chatJid),
      messageId: null,
      indexError: error instanceof Error ? error.message : String(error),
    };
  }
}
