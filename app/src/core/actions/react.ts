/**
 * React to one message of a chat: the person's emoji on it, or none.
 *
 * The same road as `sendMessage` — ask the daemon that holds the account first, else open a
 * sender of our own — but with nothing to plan, log as a message or index: a reaction is not a
 * message. The write log still records it, because it reached the network. Only the window
 * calls this today; an agent has no reaction tool, so no grant is involved (ADR 0008).
 */

import { configPath, indexDbPath } from '@curlew/store';
import type { MessageBackend, MessageSender, ReplyTarget, SendPermit } from '@curlew/protocol';
import { _, fmt, isSendBackend } from '@curlew/protocol';
import { loadConfig } from '../config.ts';
import { demoActive } from '../demo/active.ts';
import type { Capability } from '../grants.ts';
import { DAEMON_WIRE_VERSION } from '../lib/daemon-bus.ts';
import { type DaemonSendClient, gioDaemonSendClient } from '../lib/daemon-send-client.ts';
import { appendWriteLog, type WriteFrontend } from '../write-log.ts';
import { requireEncryptionFor } from './omemo.ts';
import { findAccountBackend, holdReceiveLease, routeThroughDaemon, sendTarget } from './send.ts';

export interface ReactParams {
  accountId: string;
  /** The chat's address, as for a send. */
  to: string;
  target: ReplyTarget;
  /** The emoji to react with; null takes the person's reaction back. */
  emoji: string | null;
  /** With `emoji: null`: the emoji being taken back (see `SendingReaction.previous`). */
  previous?: string;
  frontend: WriteFrontend;
  dbPath?: string;
  configPath?: string;
  writeLogPath?: string;
  /** Injected by tests: the backend that opens the sender. */
  backend?: MessageBackend;
  /** Injected by tests: how a request reaches a running daemon. */
  daemon?: DaemonSendClient;
}

/** Put one reaction on the wire through an open handle. Shared by the direct path and the daemon. */
export async function reactThrough(
  sender: MessageSender,
  request: { to: string; target: ReplyTarget; emoji: string | null; previous?: string },
  backendName: string,
): Promise<void> {
  if (!sender.features.reactions || sender.react === undefined) {
    throw new Error(fmt(_('{backend} cannot send a reaction'), { backend: backendName }));
  }
  await sender.react(request);
}

export async function reactToMessage(params: ReactParams): Promise<void> {
  if (demoActive()) throw new Error(_('Demo mode: nothing is sent.'));
  const config = loadConfig(params.configPath ?? configPath());
  const found = await findAccountBackend(config, params.accountId, params.backend);
  if (found === null) {
    throw new Error(
      fmt(_('no account {account} — `curlew accounts list` shows them'), { account: params.accountId }),
    );
  }
  const backend = found.backend;
  if (!isSendBackend(backend))
    throw new Error(fmt(_('{backend} cannot send'), { backend: backend.manifest.name }));
  if (!backend.manifest.capabilities.reactions) {
    throw new Error(fmt(_('{backend} cannot send a reaction'), { backend: backend.manifest.name }));
  }
  const capability = `${backend.manifest.name}.send` as Capability;
  const permit: SendPermit = { account: params.accountId, addresses: [params.to] };
  const request = {
    to: params.to,
    target: params.target,
    emoji: params.emoji,
    ...(params.previous === undefined ? {} : { previous: params.previous }),
  };

  const routed = backend.manifest.sendSharesReceiveState
    ? await routeThroughDaemon(params.daemon ?? gioDaemonSendClient(), {
        v: DAEMON_WIRE_VERSION,
        backend: backend.manifest.name,
        account: params.accountId,
        capability,
        to: params.to,
        reaction: {
          target: params.target,
          emoji: params.emoji,
          ...(request.previous === undefined ? {} : { previous: request.previous }),
        },
      })
    : null;
  if (routed === null) {
    const lease = backend.manifest.sendSharesReceiveState
      ? holdReceiveLease(params.dbPath ?? indexDbPath(), backend.manifest.name, params.accountId)
      : null;
    let sender: MessageSender;
    try {
      sender = await backend.openSender(params.accountId, permit, {
        decrypt: true,
        requireEncryption: requireEncryptionFor(config, params.accountId, permit.addresses),
      });
    } catch (error) {
      lease?.release();
      throw error;
    }
    try {
      await reactThrough(sender, request, backend.manifest.name);
    } finally {
      await sender.close().catch(() => {});
      lease?.release();
    }
  }
  appendWriteLog(
    {
      capability,
      target: sendTarget(params.accountId, params.to),
      frontend: params.frontend,
      id: `reaction:${params.target.remoteId}`,
    },
    { path: params.writeLogPath },
  );
}
