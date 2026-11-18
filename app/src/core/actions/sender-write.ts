/**
 * The road every non-message write (edit, delete, reaction) takes: ask the daemon that holds the
 * account first, else open a sender of our own, then record it in the write log.
 */

import { configPath, indexDbPath } from '@curlew/store';
import type { MessageBackend, MessageSender, SendPermit } from '@curlew/protocol';
import { _, fmt, isSendBackend } from '@curlew/protocol';
import { loadConfig } from '../config.ts';
import { demoActive } from '../demo/active.ts';
import type { Capability } from '../grants.ts';
import { DAEMON_WIRE_VERSION, type DaemonSendRequest } from '../lib/daemon-bus.ts';
import { type DaemonSendClient, gioDaemonSendClient } from '../lib/daemon-send-client.ts';
import { appendWriteLog, type WriteFrontend } from '../write-log.ts';
import { requireEncryptionFor } from './omemo.ts';
import { findAccountBackend, holdReceiveLease, routeThroughDaemon, sendTarget } from './send.ts';

export interface SenderWriteParams {
  accountId: string;
  /** The chat's address, as for a send. */
  to: string;
  frontend: WriteFrontend;
  dbPath?: string;
  configPath?: string;
  writeLogPath?: string;
  /** Injected by tests: the backend that opens the sender. */
  backend?: MessageBackend;
  /** Injected by tests: how a request reaches a running daemon. */
  daemon?: DaemonSendClient;
}

export interface SenderWrite {
  /** The wire field that carries the operation (`edit`, `delete`, `reaction`). */
  wire:
    | Pick<DaemonSendRequest, 'edit'>
    | Pick<DaemonSendRequest, 'delete'>
    | Pick<DaemonSendRequest, 'reaction'>;
  /** Write-log id of the operation. */
  logId: string;
  /** Refuses early when the backend cannot do this at all. */
  check?: (backend: MessageBackend) => void;
  /** Apply the operation through an open handle. */
  apply: (sender: MessageSender, backendName: string) => Promise<void>;
}

export async function writeThroughSender(params: SenderWriteParams, write: SenderWrite): Promise<void> {
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
  write.check?.(backend);
  const capability = `${backend.manifest.name}.send` as Capability;
  const permit: SendPermit = { account: params.accountId, addresses: [params.to] };

  const routed = backend.manifest.sendSharesReceiveState
    ? await routeThroughDaemon(params.daemon ?? gioDaemonSendClient(), {
        v: DAEMON_WIRE_VERSION,
        backend: backend.manifest.name,
        account: params.accountId,
        capability,
        to: params.to,
        ...write.wire,
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
      await write.apply(sender, backend.manifest.name);
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
      id: write.logId,
    },
    { path: params.writeLogPath },
  );
}
