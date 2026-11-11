/**
 * `message_save_attachment` for chat messages — one attachment from any chat backend.
 *
 * Like mail attachments, the bytes are not in the index: only the descriptor is. The fetch needs
 * the backend's opaque handle, which never leaves `@curlew/store`. An agent frontend passes the
 * same read-access gate as the body before any bytes move.
 *
 * Routing mirrors `send.ts`: if a daemon is holding the account, the fetch goes to it over the
 * session bus and runs on the connection that is already up; otherwise the direct path opens the
 * backend's attachment handle here.
 */

import { basename } from 'node:path';
import type { DaemonSendClient } from '../lib/daemon-send-client.ts';
import {
  DAEMON_WIRE_VERSION,
  type DaemonFetchAttachmentReply,
  type DaemonFetchAttachmentRequest,
} from '../lib/daemon-bus.ts';
import type { AgentAccess } from './access.ts';
import { loadConfig, type CurlewConfig } from '../config.ts';
import { configPath, indexDbPath } from '@curlew/store';
import {
  attachmentsDir,
  ensurePrivateDir,
  fallbackAttachmentName,
  FileSink,
  loadAttachmentHandle,
  loadAttachments,
  messageParticipantAddresses,
  resolveDownloadPath,
} from '@curlew/store';
import type { IndexDatabase } from '@curlew/store';
import type { MessageBackend, MessageRef, SaveAttachmentResult } from '@curlew/protocol';
import { isAttachmentFetcherBackend, safeFileName, _, fmt } from '@curlew/protocol';
import { openIndex } from './index-sync.ts';
import { builtinRegistry } from '../backends/builtin.ts';
import { backendContext } from '../backends/context.ts';
import { gioDaemonSendClient } from '../lib/daemon-send-client.ts';
import { ATTACHMENT_BYTES, capLimit } from './limits.ts';
import { requireParticipantsRead } from './message-access.ts';

export interface ChatSaveAttachmentParams {
  /** Which message the attachment belongs to. */
  ref: MessageRef;
  /** Which attachment of the message (its `index`). */
  index: number;
  /** Directory to save into. The daemon path ignores this — it returns its own previews directory. */
  directory?: string;
  /** Refuse a part larger than this, before any bytes are transferred. */
  maxBytes?: number;
  /** Set by an agent frontend: saving needs the same `read` access as the body. */
  agent?: AgentAccess;
  configPath?: string;
  dbPath?: string;
  /** Injected by tests: the backend to fetch from. */
  backend?: MessageBackend;
  /** Injected by tests: how a fetch reaches a running daemon. */
  daemon?: DaemonSendClient;
}

/** The chat backend that has this account, or the one a test injected. */
async function findChatBackend(
  config: CurlewConfig,
  backendName: string,
  accountId: string,
  injected?: MessageBackend,
): Promise<MessageBackend | null> {
  if (injected) return injected;
  const registry = builtinRegistry();
  let candidate: MessageBackend | null = null;
  try {
    candidate = registry.create(config, backendName, backendContext(backendName, config));
  } catch {
    return null;
  }
  if (candidate === null) return null;
  try {
    const account = (await candidate.listAccounts()).find((a) => a.id === accountId);
    if (account) return candidate;
  } catch {
    // Account list failure means we cannot confirm it belongs here.
  }
  return null;
}

/** Require read access to the conversation a chat message belongs to. */
async function requireChatMessageRead(
  db: IndexDatabase,
  config: CurlewConfig,
  agent: AgentAccess,
  ref: MessageRef,
): Promise<void> {
  const addresses = messageParticipantAddresses(db, ref);
  await requireParticipantsRead(config, agent, ref.accountId, addresses);
}

/** Hand the fetch to the daemon that is holding this account, or answer null when none is. */
async function routeThroughDaemon(
  client: DaemonSendClient,
  request: DaemonFetchAttachmentRequest,
): Promise<DaemonFetchAttachmentReply | null> {
  const reply = await client.fetchAttachment(request);
  if (reply === null) return null;
  switch (reply.kind) {
    case 'fetched':
    case 'not-followed':
    case 'refused':
    case 'failed':
      return reply;
    default:
      return null;
  }
}

/** Save one chat attachment to disk and report where it landed. */
export async function chatSaveAttachment(params: ChatSaveAttachmentParams): Promise<SaveAttachmentResult> {
  const config = loadConfig(params.configPath ?? configPath());
  // The gate comes first: a denied agent must not learn whether the attachment exists.
  if (params.agent) {
    const gateDb = openIndex(params.dbPath ?? indexDbPath());
    try {
      await requireChatMessageRead(gateDb, config, params.agent, params.ref);
    } finally {
      gateDb.close();
    }
  }

  const db = openIndex(params.dbPath ?? indexDbPath());
  let info;
  let handle: string | null = null;
  try {
    const infos = loadAttachments(db, params.ref);
    info = infos.find((a) => a.index === params.index);
    handle = info === undefined ? null : loadAttachmentHandle(db, params.ref, params.index);
  } finally {
    db.close();
  }
  if (info === undefined) {
    throw new Error(_('the attachment was not found in the index'));
  }
  if (!info.fetchable || handle === null || handle === '') {
    throw new Error(_('the attachment has no fetchable handle'));
  }

  const maxBytes = capLimit(params.maxBytes, ATTACHMENT_BYTES);
  const request: DaemonFetchAttachmentRequest = {
    v: DAEMON_WIRE_VERSION,
    backend: params.ref.backend,
    account: params.ref.accountId,
    remoteId: params.ref.remoteId ?? '',
    index: params.index,
    maxBytes,
  };

  const routed = await routeThroughDaemon(params.daemon ?? gioDaemonSendClient(), request);
  if (routed !== null) {
    switch (routed.kind) {
      case 'fetched':
        return {
          path: routed.path,
          filename: routed.filename,
          bytes: routed.bytes,
          mimeType: routed.mimeType,
          section: String(params.index),
        };
      case 'not-followed':
        break;
      case 'refused':
      case 'failed':
        throw new Error(routed.message);
    }
  }

  // Direct path: open the backend's attachment handle and fetch.
  const backend = await findChatBackend(config, params.ref.backend, params.ref.accountId, params.backend);
  if (backend === null) {
    throw new Error(
      fmt(_('no account {account} for {backend}'), {
        account: params.ref.accountId,
        backend: params.ref.backend,
      }),
    );
  }
  if (!isAttachmentFetcherBackend(backend)) {
    throw new Error(fmt(_('{backend} cannot fetch attachments'), { backend: params.ref.backend }));
  }

  const directory = ensurePrivateDir(params.directory ?? attachmentsDir());
  const filename = safeFileName(info.filename, fallbackAttachmentName(info));
  const path = resolveDownloadPath(directory, filename, 'attachment');
  const sink = new FileSink(path);
  try {
    const fetcher = await backend.openAttachments(params.ref.accountId);
    const result = await fetcher.fetchAttachment(
      { backend: params.ref.backend, accountId: params.ref.accountId },
      { kind: info.kind, handle },
      sink,
      { maxBytes },
    );
    sink.close();
    return {
      path,
      filename: basename(path),
      bytes: result.size,
      mimeType: result.mimeType ?? info.mimeType ?? 'application/octet-stream',
      section: String(params.index),
    };
  } catch (error) {
    sink.abort(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
