/**
 * Push the person's read position to their OWN devices (#441, part 2).
 *
 * The local position (`conversation_read_state`) is what the window shows; this is the network
 * half: Matrix `m.read.private`, Signal `SyncMessage.Read`, XMPP MDS, IMAP `\Seen`. None of
 * those tells the other person. Telegram and WhatsApp have no private form — reading there IS the
 * receipt the other person sees — so those two go out only while `ui.sendReadReceipts` is on.
 *
 * The same road as a reaction: the daemon that holds the account first (`SyncRead` on the session
 * bus), else a sender of our own. Failure is the caller's to log, never to show: the position is
 * local already and the next change tries again. Only the window calls this; an agent gets no
 * read-sync tool, so no grant is involved (ADR 0008).
 */

import { configPath, indexDbPath, openIndexDb } from '@curlew/store';
import type { IndexDatabase } from '@curlew/store';
import type { MessageBackend, MessageSender, ReplyTarget, SendPermit } from '@curlew/protocol';
import { isSendBackend } from '@curlew/protocol';
import { loadConfig, type CurlewConfig } from '../config.ts';
import { demoActive } from '../demo/active.ts';
import { DAEMON_WIRE_VERSION } from '../lib/daemon-bus.ts';
import { type DaemonSendClient, gioDaemonSendClient } from '../lib/daemon-send-client.ts';
import { appendWriteLog, type WriteFrontend } from '../write-log.ts';
import type { Capability } from '../grants.ts';
import { findAccountBackend, holdReceiveLease, sendTarget } from './send.ts';

/** The networks whose read marker is visible to the other person. */
const PEER_VISIBLE = new Set(['telegram', 'whatsapp']);

/** The most mail UIDs one sync carries; older ones were read long ago and some other device has them. */
const MAX_UIDS = 500;

/** Whether this backend's read position may leave the machine under the person's settings. */
export function readSyncAllowed(config: CurlewConfig, backend: string): boolean {
  if (config.ui.syncReadState === false) return false;
  if (PEER_VISIBLE.has(backend)) return config.ui.sendReadReceipts === true;
  return true;
}

export interface ReadSyncPlan {
  target: ReplyTarget;
  sentAt: string;
  uids?: number[];
  folder?: string;
}

const time = (value: string): number => Date.parse(value);

function newer(a: string, b: string): boolean {
  const x = time(a);
  const y = time(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a > b : x > y;
}

/**
 * What the person read in these conversations: the newest incoming message, and for mail the UIDs
 * of the mailbox it lives in. Null when there is nothing incoming to name.
 */
export function planReadSync(db: IndexDatabase, conversationIds: readonly string[]): ReadSyncPlan | null {
  let best: {
    remoteId: string;
    clientId?: string;
    sentAt: string;
    folder: string | null;
    uid: number | null;
  } | null = null;
  const mail = new Map<string, number[]>();
  for (const id of conversationIds) {
    const rows = db
      .prepare(
        'SELECT remote_id, client_id, sent_at, folder_path, uid FROM conversation_messages WHERE conversation_id = ? AND from_self = 0 AND sent_at IS NOT NULL',
      )
      .all(id) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const sentAt = String(r.sent_at);
      const folder = r.folder_path === null || r.folder_path === undefined ? null : String(r.folder_path);
      const uid = r.uid === null || r.uid === undefined ? null : Number(r.uid);
      if (folder !== null && uid !== null && Number.isFinite(uid)) {
        const list = mail.get(folder) ?? [];
        list.push(uid);
        mail.set(folder, list);
      }
      const remoteId = r.remote_id === null || r.remote_id === undefined ? null : String(r.remote_id);
      const key = remoteId ?? (uid === null ? null : String(uid));
      if (key === null) continue;
      if (best === null || newer(sentAt, best.sentAt)) {
        best = {
          remoteId: key,
          ...(r.client_id === null || r.client_id === undefined ? {} : { clientId: String(r.client_id) }),
          sentAt,
          folder,
          uid,
        };
      }
    }
  }
  if (best === null) return null;
  const plan: ReadSyncPlan = {
    target: {
      remoteId: best.remoteId,
      ...(best.clientId === undefined ? {} : { clientId: best.clientId }),
      fromSelf: false,
    },
    sentAt: best.sentAt,
  };
  if (best.folder !== null) {
    plan.folder = best.folder;
    plan.uids = (mail.get(best.folder) ?? []).sort((a, b) => b - a).slice(0, MAX_UIDS);
  }
  return plan;
}

/** Put one read position on the wire through an open handle. Shared by the direct path and the daemon. */
export async function readSyncThrough(
  sender: MessageSender,
  request: { to: string; target: ReplyTarget; sentAt: string; uids?: number[]; folder?: string },
): Promise<boolean> {
  if (!sender.features.readSync || sender.readSync === undefined) return false;
  await sender.readSync(request);
  return true;
}

export interface SyncReadParams {
  accountId: string;
  /** The canonical conversations the row stands for. */
  conversationIds: string[];
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

export type SyncReadOutcome = 'synced' | 'off' | 'nothing' | 'unsupported';

export async function syncReadState(params: SyncReadParams): Promise<SyncReadOutcome> {
  if (demoActive()) return 'off';
  const config = loadConfig(params.configPath ?? configPath());
  if (config.ui.syncReadState === false) return 'off';
  const found = await findAccountBackend(config, params.accountId, params.backend);
  if (found === null) throw new Error(`no account ${params.accountId}`);
  const backend = found.backend;
  const name = backend.manifest.name;
  if (!isSendBackend(backend)) return 'unsupported';
  if (!readSyncAllowed(config, name)) return 'off';

  const db = openIndexDb(params.dbPath ?? indexDbPath(), { busyTimeoutMs: 300 });
  let plan: ReadSyncPlan | null;
  try {
    plan = planReadSync(db, params.conversationIds);
  } finally {
    db.close();
  }
  if (plan === null) return 'nothing';

  const capability = `${name}.send` as Capability;
  const permit: SendPermit = { account: params.accountId, addresses: [params.to] };
  const request = {
    to: params.to,
    target: plan.target,
    sentAt: plan.sentAt,
    ...(plan.uids === undefined ? {} : { uids: plan.uids }),
    ...(plan.folder === undefined ? {} : { folder: plan.folder }),
  };

  let done = false;
  if (backend.manifest.sendSharesReceiveState) {
    const reply = await (params.daemon ?? gioDaemonSendClient()).syncRead({
      v: DAEMON_WIRE_VERSION,
      backend: name,
      account: params.accountId,
      to: params.to,
      target: {
        remoteId: plan.target.remoteId,
        ...(plan.target.clientId === undefined ? {} : { clientId: plan.target.clientId }),
        fromSelf: false,
      },
      sentAt: plan.sentAt,
    });
    if (reply !== null && (reply.kind === 'refused' || reply.kind === 'failed'))
      throw new Error(reply.message);
    done = reply?.kind === 'synced';
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
      if (!(await readSyncThrough(sender, request))) return 'unsupported';
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
      id: `read:${plan.target.remoteId}`,
    },
    { path: params.writeLogPath },
  );
  return 'synced';
}
