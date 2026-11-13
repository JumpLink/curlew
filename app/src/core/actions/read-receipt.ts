/**
 * Confirm to a Delta Chat peer that the person opened their messages.
 *
 * Sent only when the person switched `ui.sendReadReceipts` on, only for a message that asked for
 * it with `Chat-Disposition-Notification-To` (never plain `Disposition-Notification-To`), and once
 * per message. Mail has no daemon route (`sendSharesReceiveState` is false), so this opens a sender
 * itself. The window is the only caller; an agent has no tool for it, so no grant is involved.
 */

import { configPath, indexDbPath, markReceiptSent, openIndexDb, pendingReadReceipts } from '@curlew/store';
import type { MessageBackend, MessageSender, SendPermit } from '@curlew/protocol';
import { _, fmt, isSendBackend } from '@curlew/protocol';
import { loadConfig } from '../config.ts';
import { demoActive } from '../demo/active.ts';
import type { Capability } from '../grants.ts';
import { appendWriteLog, type WriteFrontend } from '../write-log.ts';
import { findAccountBackend, sendTarget } from './send.ts';

export interface ReadReceiptParams {
  accountId: string;
  /** The conversation the person just opened. */
  conversationId: string;
  frontend: WriteFrontend;
  dbPath?: string;
  configPath?: string;
  writeLogPath?: string;
  /** Injected by tests: the backend that opens the sender. */
  backend?: MessageBackend;
}

/** Receipts sent for the conversation; 0 when the setting is off or nothing asked for one. */
export async function sendReadReceipts(params: ReadReceiptParams): Promise<number> {
  if (demoActive()) return 0;
  const config = loadConfig(params.configPath ?? configPath());
  if (config.ui.sendReadReceipts !== true) return 0;
  const dbPath = params.dbPath ?? indexDbPath();
  const db = openIndexDb(dbPath, { busyTimeoutMs: 300 });
  let pending;
  try {
    pending = pendingReadReceipts(db, params.conversationId).filter((p) => p.accountId === params.accountId);
  } finally {
    db.close();
  }
  if (pending.length === 0) return 0;

  const found = await findAccountBackend(config, params.accountId, params.backend);
  if (found === null) {
    throw new Error(
      fmt(_('no account {account} — `curlew accounts list` shows them'), { account: params.accountId }),
    );
  }
  const backend = found.backend;
  if (!isSendBackend(backend) || !backend.manifest.capabilities.readReceipts) return 0;
  const capability = `${backend.manifest.name}.send` as Capability;
  const permit: SendPermit = { account: params.accountId, addresses: [...new Set(pending.map((p) => p.to))] };
  const sender: MessageSender = await backend.openSender(params.accountId, permit, { decrypt: true });
  let sent = 0;
  try {
    if (!sender.features.readReceipts || sender.readReceipt === undefined) return 0;
    for (const receipt of pending) {
      await sender.readReceipt({
        to: receipt.to,
        target: { remoteId: receipt.messageId, emailChat: true },
      });
      const write = openIndexDb(dbPath, { busyTimeoutMs: 300 });
      try {
        markReceiptSent(write, receipt.accountId, receipt.messageId);
      } finally {
        write.close();
      }
      appendWriteLog(
        {
          capability,
          target: sendTarget(params.accountId, receipt.to),
          frontend: params.frontend,
          id: `read-receipt:${receipt.messageId}`,
        },
        { path: params.writeLogPath },
      );
      sent++;
    }
  } finally {
    await sender.close().catch(() => {});
  }
  return sent;
}
