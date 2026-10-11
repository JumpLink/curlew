/**
 * `curlew send` / `send_message` — one plain-text chat message from a granted XMPP account.
 *
 * Both frontends call this, and this is where the grant is checked (ADR 0004 §4): the CLI is no
 * back door for an agent with a shell. The grant names `<account>/<address>` exactly; the permit
 * handed to the XMPP session lists only the addresses granted for this account, and the session
 * checks it again on send.
 *
 * Order matters: send, then index the outgoing message, then the write log. The log line carries
 * the id the send returned, so it goes last; a failing log is a failed call.
 */

import { configPath, indexDbPath, recordSentChatMessage } from '@curlew/store';
import { XmppBackend } from '@curlew/xmpp';
import type { SendPermit } from '@curlew/xmpp';
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
  text: string;
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
  messageId: string;
  chatJid: string;
  originId: string;
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
  const backend = params.backend ?? createXmppBackend(config);
  const account = (await backend.listAccounts()).find((a) => a.id === params.accountId);
  if (!account) throw new Error(`no xmpp account ${params.accountId} — \`curlew accounts list\` shows them`);

  const session = await backend.openGranted(params.accountId, permitFor(config.grants, params.accountId));
  let sent;
  try {
    sent = await session.send(params.to, params.text);
  } finally {
    await session.close().catch(() => {});
  }

  const db = openIndex(params.dbPath ?? indexDbPath());
  let recorded;
  try {
    recorded = recordSentChatMessage(db, {
      backend: 'xmpp',
      account,
      chatRemoteId: sent.chatJid,
      clientId: sent.originId,
      text: params.text,
      sentAt: sent.sentAt,
    });
  } finally {
    db.close();
  }
  appendWriteLog(
    {
      capability: SEND_CAPABILITY,
      target: sendTarget(params.accountId, params.to),
      frontend: params.frontend,
      id: sent.originId,
    },
    { path: params.writeLogPath },
  );
  return { ...recorded, chatJid: sent.chatJid, originId: sent.originId, sentAt: sent.sentAt };
}
