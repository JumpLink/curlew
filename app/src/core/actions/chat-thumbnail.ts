/**
 * Fetch one chat attachment's THUMBNAIL by its thumb handle (ADR 0017 §2), never the file.
 *
 * Same routing as `chatSaveAttachment`: a daemon that holds the account does the fetch (wire flag
 * `thumb`), otherwise the direct path opens the backend's attachment fetcher here. The handle is
 * read inside this module and the daemon; the window only learns the path of the stored file.
 */

import { unlinkSync } from 'node:fs';
import type { AttachmentFetcher, ByteSink, MessageBackend, MessageRef } from '@curlew/protocol';
import { isAttachmentFetcherBackend, _, fmt } from '@curlew/protocol';
import type { IndexDatabase } from '@curlew/store';
import {
  configPath,
  ensurePrivateDir,
  FileSink,
  indexDbPath,
  loadThumbTarget,
  setThumbState,
  THUMBNAIL_FETCH_MAX_BYTES,
  thumbPath,
  thumbsDir,
} from '@curlew/store';
import { loadConfig } from '../config.ts';
import { DAEMON_WIRE_VERSION, type DaemonFetchAttachmentRequest } from '../lib/daemon-bus.ts';
import { gioDaemonSendClient, type DaemonSendClient } from '../lib/daemon-send-client.ts';
import { builtinRegistry } from '../backends/builtin.ts';
import { backendContext } from '../backends/context.ts';
import { openIndex } from './index-sync.ts';

export interface ChatThumbnailParams {
  ref: MessageRef;
  index: number;
  configPath?: string;
  dbPath?: string;
  /** Injected by tests. */
  backend?: MessageBackend;
  daemon?: DaemonSendClient;
  /** Injected by tests; `thumbsDir()` when unset. */
  root?: string;
}

/**
 * Fetch the thumbnail behind the stored handle into `thumbPath(...)` and set `thumb_state`:
 * `'stored'` on success, `'failed'` when the fetch throws (the error is rethrown). Returns null
 * when the row offers no handle to fetch.
 */
export async function storeThumbnail(
  db: IndexDatabase,
  fetcher: AttachmentFetcher,
  ref: MessageRef,
  index: number,
  options: { signal?: AbortSignal; root?: string; wrap?: (sink: ByteSink) => ByteSink } = {},
): Promise<{ path: string; bytes: number; mimeType: string | null } | null> {
  const target = loadThumbTarget(db, ref, index);
  if (target === null) return null;
  const root = options.root ?? thumbsDir();
  ensurePrivateDir(root);
  const path = thumbPath(target.messageId, index, root);
  // A leftover from a crashed fetch would make the exclusive open fail.
  try {
    unlinkSync(`${path}.part`);
  } catch {
    // None there: the usual case.
  }
  const sink = new FileSink(path);
  try {
    const result = await fetcher.fetchAttachment(
      { backend: ref.backend, accountId: ref.accountId },
      { kind: target.kind, handle: target.handle },
      options.wrap ? options.wrap(sink) : sink,
      { maxBytes: THUMBNAIL_FETCH_MAX_BYTES, ...(options.signal ? { signal: options.signal } : {}) },
    );
    sink.close();
    setThumbState(db, target.messageId, index, 'stored');
    return { path, bytes: result.size, mimeType: result.mimeType };
  } catch (error) {
    sink.abort(error instanceof Error ? error.message : String(error));
    setThumbState(db, target.messageId, index, 'failed');
    throw error;
  }
}

async function findBackend(
  params: ChatThumbnailParams,
  config: ReturnType<typeof loadConfig>,
): Promise<MessageBackend | null> {
  if (params.backend) return params.backend;
  try {
    const candidate = builtinRegistry().create(
      config,
      params.ref.backend,
      backendContext(params.ref.backend, config),
    );
    if (candidate === null) return null;
    const accounts = await candidate.listAccounts();
    return accounts.some((a) => a.id === params.ref.accountId) ? candidate : null;
  } catch {
    return null;
  }
}

/** The thumbnail file of a part, fetched by its thumb handle when it is not stored yet. */
export async function chatFetchThumbnail(params: ChatThumbnailParams): Promise<string> {
  const { ref, index } = params;
  const db = openIndex(params.dbPath ?? indexDbPath());
  try {
    if (loadThumbTarget(db, ref, index) === null) {
      throw new Error(_('the attachment has no thumbnail to fetch'));
    }
  } finally {
    db.close();
  }

  const request: DaemonFetchAttachmentRequest = {
    v: DAEMON_WIRE_VERSION,
    backend: ref.backend,
    account: ref.accountId,
    remoteId: ref.remoteId ?? '',
    index,
    maxBytes: THUMBNAIL_FETCH_MAX_BYTES,
    thumb: true,
  };
  const reply = await (params.daemon ?? gioDaemonSendClient()).fetchAttachment(request);
  if (reply !== null) {
    if (reply.kind === 'fetched') return reply.path;
    if (reply.kind === 'refused' || reply.kind === 'failed') throw new Error(reply.message);
  }

  const config = loadConfig(params.configPath ?? configPath());
  const backend = await findBackend(params, config);
  if (backend === null) {
    throw new Error(
      fmt(_('no account {account} for {backend}'), { account: ref.accountId, backend: ref.backend }),
    );
  }
  if (!isAttachmentFetcherBackend(backend)) {
    throw new Error(fmt(_('{backend} cannot fetch attachments'), { backend: ref.backend }));
  }
  const fetcher = await backend.openAttachments(ref.accountId);
  const writeDb = openIndex(params.dbPath ?? indexDbPath());
  try {
    const stored = await storeThumbnail(
      writeDb,
      fetcher,
      ref,
      index,
      params.root ? { root: params.root } : {},
    );
    if (stored === null) throw new Error(_('the attachment has no thumbnail to fetch'));
    return stored.path;
  } finally {
    writeDb.close();
  }
}
