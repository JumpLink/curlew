/**
 * Push the person's mute or favourite of one chat to the network (ADR 0020 §5).
 *
 * The local flag (`conversation_flags`) is what the window shows; this is the network half. The
 * same road as a read sync: the daemon that holds the account first (`SetChatFlags` on the session
 * bus), else a sender of our own. Failure is the caller's to log, never to show: the flag is local
 * already and its `*_pending_at` stays set, so the next sync resolves it by the rule in §4.
 */

import { configPath, indexDbPath } from '@curlew/store';
import type { MessageBackend, MessageSender, SendingChatFlags, SendPermit } from '@curlew/protocol';
import { isSendBackend } from '@curlew/protocol';
import { loadConfig } from '../config.ts';
import { demoActive } from '../demo/active.ts';
import { DAEMON_WIRE_VERSION } from '../lib/daemon-bus.ts';
import { type DaemonSendClient, gioDaemonSendClient } from '../lib/daemon-send-client.ts';
import { appendWriteLog, type WriteFrontend } from '../write-log.ts';
import type { Capability } from '../grants.ts';
import { findAccountBackend, holdReceiveLease, sendTarget } from './send.ts';

/** Put one flag change on the wire through an open handle. Shared by the direct path and the daemon. */
export async function chatFlagsThrough(sender: MessageSender, flags: SendingChatFlags): Promise<boolean> {
  if (!sender.features.chatFlags || sender.setChatFlags === undefined) return false;
  await sender.setChatFlags(flags);
  return true;
}

export interface PushChatFlagsParams {
  accountId: string;
  /** The chat's address, as for a send. */
  to: string;
  mute?: SendingChatFlags['mute'];
  favourite?: boolean;
  frontend: WriteFrontend;
  dbPath?: string;
  configPath?: string;
  writeLogPath?: string;
  /** Injected by tests: the backend that opens the sender. */
  backend?: MessageBackend;
  /** Injected by tests: how a request reaches a running daemon. */
  daemon?: DaemonSendClient;
}

/** `local` = the network keeps no such flag for this backend: the flag stays in curlew. */
export type PushChatFlagsOutcome = 'pushed' | 'local' | 'nothing';

export async function pushChatFlags(params: PushChatFlagsParams): Promise<PushChatFlagsOutcome> {
  if (params.mute === undefined && params.favourite === undefined) return 'nothing';
  if (demoActive()) return 'local';
  const config = loadConfig(params.configPath ?? configPath());
  const found = await findAccountBackend(config, params.accountId, params.backend);
  if (found === null) throw new Error(`no account ${params.accountId}`);
  const backend = found.backend;
  const name = backend.manifest.name;
  const capabilities = backend.manifest.capabilities;
  if (!isSendBackend(backend) || (capabilities?.mutes !== true && capabilities?.pins !== true))
    return 'local';

  const flags: SendingChatFlags = {
    to: params.to,
    ...(params.mute === undefined ? {} : { mute: params.mute }),
    ...(params.favourite === undefined ? {} : { favourite: params.favourite }),
  };
  const permit: SendPermit = { account: params.accountId, addresses: [params.to] };

  let done = false;
  if (backend.manifest.sendSharesReceiveState) {
    const reply = await (params.daemon ?? gioDaemonSendClient()).setChatFlags({
      v: DAEMON_WIRE_VERSION,
      backend: name,
      account: params.accountId,
      to: params.to,
      ...(params.mute === undefined ? {} : { mute: params.mute }),
      ...(params.favourite === undefined ? {} : { favourite: params.favourite }),
    });
    if (reply !== null && (reply.kind === 'refused' || reply.kind === 'failed'))
      throw new Error(reply.message);
    done = reply?.kind === 'set';
  }
  if (!done) {
    const lease = backend.manifest.sendSharesReceiveState
      ? holdReceiveLease(params.dbPath ?? indexDbPath(), name, params.accountId)
      : null;
    let sender: MessageSender;
    try {
      sender = await backend.openSender(params.accountId, permit, { decrypt: true });
    } catch (error) {
      lease?.release();
      throw error;
    }
    try {
      if (!(await chatFlagsThrough(sender, flags))) return 'local';
    } finally {
      await sender.close().catch(() => {});
      lease?.release();
    }
  }
  appendWriteLog(
    {
      capability: `${name}.send` as Capability,
      target: sendTarget(params.accountId, params.to),
      frontend: params.frontend,
      id: `flags:${params.mute === undefined ? 'favourite' : 'mute'}`,
    },
    { path: params.writeLogPath },
  );
  return 'pushed';
}
