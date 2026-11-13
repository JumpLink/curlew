/**
 * Edit one of the person's own messages in a chat.
 *
 * The same road as `sendMessage` — ask the daemon that holds the account first, else open a
 * sender of our own — but with nothing to plan, log as a message or index: an edit is not a new
 * message. The write log still records it, because it reached the network. Only the window calls
 * this today; an agent has no edit tool, so no grant is involved (ADR 0008).
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

export interface EditParams {
  accountId: string;
  /** The chat's address, as for a send. */
  to: string;
  target: ReplyTarget;
  /** The new text for the message. */
  text: string;
  frontend: WriteFrontend;
  dbPath?: string;
  configPath?: string;
  writeLogPath?: string;
  /** Injected by tests: the backend that opens the sender. */
  backend?: MessageBackend;
  /** Injected by tests: how a request reaches a running daemon. */
  daemon?: DaemonSendClient;
}

/** Apply one edit through an open handle. Shared by the direct path and the daemon. */
export async function editThrough(
  sender: MessageSender,
  request: { to: string; target: ReplyTarget; text: string },
  backendName: string,
): Promise<void> {
  if (!sender.features.edits || sender.edit === undefined) {
    throw new Error(fmt(_('{backend} cannot edit a message'), { backend: backendName }));
  }
  if (request.target.fromSelf !== true) {
    throw new Error(_('only your own messages can be edited'));
  }
  await sender.edit(request);
}

export async function editMessage(params: EditParams): Promise<void> {
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
  const capability = `${backend.manifest.name}.send` as Capability;
  const permit: SendPermit = { account: params.accountId, addresses: [params.to] };
  const request = { to: params.to, target: params.target, text: params.text };

  const routed = backend.manifest.sendSharesReceiveState
    ? await routeThroughDaemon(params.daemon ?? gioDaemonSendClient(), {
        v: DAEMON_WIRE_VERSION,
        backend: backend.manifest.name,
        account: params.accountId,
        capability,
        to: params.to,
        edit: { target: params.target, text: params.text },
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
      await editThrough(sender, request, backend.manifest.name);
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
      id: `edit:${params.target.remoteId}`,
    },
    { path: params.writeLogPath },
  );
}
