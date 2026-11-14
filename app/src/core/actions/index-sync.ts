/**
 * Index actions — building the local index and reporting on it.
 *
 * This module is where the two halves are joined: the registry provides the enabled backends,
 * `@curlew/store` owns the database and the algorithms, and neither imports the other. The
 * injection happens here and nowhere else.
 */

import { searchContacts } from '@curlew/gnome';
import { type ContactDTO, _, fmt, isChatBackend, isDeliveryBackend, isMailBackend } from '@curlew/protocol';
import type {
  ChatSyncResult,
  DeliverySyncResult,
  IndexDatabase,
  IndexSearchCriteria,
  IndexedMessage,
  OpenIndexOptions,
  RebuildResult,
  SyncResult,
  SyncStatus,
} from '@curlew/store';
import {
  configPath,
  ensurePrivateDir,
  indexDbPath,
  LEASE_HEARTBEAT_MS,
  migrate,
  openIndexDb,
  probeFts5,
  rebuildConversations,
  receiveDeliveries,
  refreshReceiveLease,
  releaseReceiveLease,
  searchIndex,
  syncChats,
  syncIndex,
  type SyncProgress,
  syncStatus,
  takeReceiveLease,
} from '@curlew/store';
import { builtinRegistry } from '../backends/builtin.ts';
import { backendContext } from '../backends/context.ts';
import { loadConfig } from '../config.ts';
import { chatOnlyAccountIds, hiddenAccountIds } from '../visibility.ts';
import { chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * How long a folder's data stays usable for an `--auto` search before it is called stale.
 * A day: long enough that routine searches do not trigger a sync, short enough that a stale
 * answer is flagged rather than silently served.
 */
export const MAX_STALENESS_HOURS = 24;

/**
 * Open the index, creating and migrating it if needed.
 *
 * The file is chmod'ed 0600 on every open, not just at creation: it holds mail headers AND
 * plain-text bodies, and a mode that drifted once would otherwise stay wrong forever.
 */
export function openIndex(path = indexDbPath(), options: OpenIndexOptions = {}) {
  if (path !== ':memory:') {
    // Create the directory 0700 BEFORE opening. Two reasons, and the second is the important
    // one: without it a fresh install has nowhere to put the database, and SQLite's `-wal` /
    // `-shm` companions are created 0644 by SQLite itself — they hold recent writes, i.e.
    // message bodies. The file mode below cannot cover them; the directory mode can.
    ensurePrivateDir(dirname(path));
  }
  const db = openIndexDb(path, options);
  migrate(db);
  // Loud, immediate failure beats an index that silently answers "no results" to everything —
  // which is what a missing FTS5 module would produce, because the wrapper swallows errors.
  probeFts5(db);
  if (path !== ':memory:') {
    try {
      chmodSync(path, 0o600);
    } catch {
      // A path the process cannot chmod (an odd mount, a foreign owner) is not a reason to
      // refuse to work; the data-directory mode is the real protection.
    }
  }
  return db;
}

export interface SyncParams {
  accountId?: string;
  folder?: string;
  fullScan?: boolean;
  dbPath?: string;
  configPath?: string;
  /**
   * Told what the run is doing while it does it. The store already reports; this is the way out
   * to a renderer, so a frontend never has to guess when the next thing will appear.
   */
  onProgress?: (event: SyncProgress) => void;
  /** Who takes the index-writer lease; the default is this process. Tests pass their own. */
  holder?: string;
  /** Short only in tests: how often the index-writer lease is refreshed. */
  leaseIntervalMs?: number;
}

/**
 * The index-writer lease — one row that says "a pull sync is writing the index right now".
 *
 * `indexSync` used to have one caller a person started by hand, so SQLite's own locking was the
 * whole story. It now has three that can be live on one machine at the same time: the daemon's
 * 15-minute tick (ADR 0002 §8), a `curlew sync` typed in a terminal, and a `curlew-sync.timer`
 * installed before the daemon took the job over. Issue #73's fix (a busy timeout on every
 * connection, `BEGIN IMMEDIATE` for every transaction) makes each STATEMENT wait its turn, which
 * is not the same thing: a sync is thousands of statements over minutes, so two runs would
 * interleave batch by batch, fetch the same mail twice and race each other's cursor updates.
 *
 * It is the receive lease (ADR 0002 §4) under a key no backend can take — `receive_leases` is
 * keyed `(backend, account_id)` and no backend is named `index` — rather than a second
 * mechanism: that lease is already a cross-process lock measured on both runtimes, and it
 * already survives a SIGKILLed holder by expiry instead of by a cleanup path.
 */
export const INDEX_LEASE_BACKEND = 'index';
export const INDEX_LEASE_ACCOUNT = 'sync';

export type IndexLeaseRun<T> =
  | { ran: true; value: T }
  /** Another process is writing the index. `null`: the index was busy and nobody is known. */
  | { ran: false; heldBy: string | null };

/**
 * Run `run` as the only index writer, or report who is already writing.
 *
 * Never waits: every caller of this is on a timer or is a command the person can repeat, so a
 * skipped run costs at most one interval, while a queue of waiting syncs would pile up behind a
 * ten-minute WhatsApp catch-up and then all run at once.
 */
export async function withIndexLease<T>(
  db: IndexDatabase,
  holder: string,
  run: () => Promise<T>,
  intervalMs: number = LEASE_HEARTBEAT_MS,
): Promise<IndexLeaseRun<T>> {
  let take: ReturnType<typeof takeReceiveLease>;
  try {
    take = takeReceiveLease(db, INDEX_LEASE_BACKEND, INDEX_LEASE_ACCOUNT, holder, new Date(), intervalMs);
  } catch {
    // A busy index means somebody is writing it. Not knowing who is the same as not holding it.
    return { ran: false, heldBy: null };
  }
  if (!take.acquired) return { ran: false, heldBy: take.holder };
  // A sync runs for minutes, far past the three intervals the lease is good for, so it has to
  // move its own expiry forward while it runs — or it would declare its own lease stale.
  const heartbeat = setInterval(() => {
    try {
      refreshReceiveLease(db, INDEX_LEASE_BACKEND, INDEX_LEASE_ACCOUNT, holder, new Date(), intervalMs);
    } catch {
      // A busy index is tried again by the next beat; the lease still has two of them left.
    }
  }, intervalMs);
  try {
    return { ran: true, value: await run() };
  } finally {
    clearInterval(heartbeat);
    try {
      releaseReceiveLease(db, INDEX_LEASE_BACKEND, INDEX_LEASE_ACCOUNT, holder);
    } catch {
      // Not released is not stuck: the lease runs out on its own three intervals from now.
    }
  }
}

export interface IndexSyncResult extends SyncResult {
  /** The enabled backends this run synced, by name. */
  backends: string[];
  /** One entry per chat backend: its accounts, the messages written, whether the budget ran out. */
  chats: Array<{ backend: string } & ChatSyncResult>;
  /**
   * One entry per delivery-only backend (WhatsApp): what it received this run. Those messages
   * exist nowhere else — the network forgot them on delivery.
   */
  deliveries: Array<{ backend: string } & DeliverySyncResult>;
  conversations: RebuildResult & {
    /** Contacts the classifier knew about; null when the address book was unreachable. */
    contacts: number | null;
  };
  /**
   * Set when this run wrote NOTHING because another process held the index-writer lease — the
   * daemon's tick, or a `curlew sync` that is still going. Not an error and not `failed`:
   * nothing failed, the index is being written, and the counts are all zero because this run
   * stood down. `null` means the index was busy and no holder could be determined.
   */
  heldBy?: string | null;
}

/** Far above any real address book: this is a full read for the classifier, not a search. */
const CONTACTS_FOR_CLASSIFIER = 1_000_000;

/**
 * The address book, for `known-contact` and participant linking — or null when EDS cannot be
 * reached (Node, a headless session). Conversations are still built then, just without it; the
 * result says so rather than pretending the address book was empty.
 */
async function addressBook(): Promise<ContactDTO[] | null> {
  try {
    return await searchContacts({ limit: CONTACTS_FOR_CLASSIFIER });
  } catch {
    return null;
  }
}

/**
 * Rebuild the conversations from the stored mail rows, with the address book.
 *
 * Shared, because the classifier's address book is a full read of EDS and a second copy of this
 * step would be a second set of bugs: `curlew sync` calls it after its writes, and the
 * receiving daemon calls it debounced after its batches (ADR 0002 §5).
 */
export async function rebuildWithAddressBook(
  db: IndexDatabase,
): Promise<RebuildResult & { contacts: number | null }> {
  const contacts = await addressBook();
  // Sync and rebuild write in multi-row batches — one wide statement per few rows rather than
  // one per row (see `insertMany` in `@curlew/store`).
  return { ...rebuildConversations(db, { contacts: contacts ?? [] }), contacts: contacts?.length ?? null };
}

export type SyncPhase = 'mail' | 'chat' | 'delivery' | 'rebuild';

const LOCKED = /database is locked|SQLITE_BUSY|database table is locked/i;

/**
 * Name the phase when the index stays locked past its busy timeout. A bare `database is locked`
 * left a timer run with nothing to go on; the phase is a fixed word, never a path, account or row.
 */
export async function inPhase<T>(phase: SyncPhase, run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!LOCKED.test(message)) throw err;
    throw new Error(
      fmt(_('the index stayed locked by another process during the {phase} phase ({message})'), {
        phase,
        message,
      }),
      { cause: err },
    );
  }
}

/**
 * Build or update the local index from every ENABLED backend, then rebuild the conversations.
 * The only operation that writes to the index.
 */
export async function indexSync(params: SyncParams = {}): Promise<IndexSyncResult> {
  const config = loadConfig(params.configPath ?? configPath());
  const registry = builtinRegistry();
  const plugins = registry.enabled(config);
  if (plugins.length === 0) {
    throw new Error(
      _('no backend is enabled — `curlew backends list` shows them, `backends enable <name>` turns one on'),
    );
  }
  const db = openIndex(params.dbPath ?? indexDbPath());
  const backends = plugins.map((p) => p.manifest.name);
  const run = async (): Promise<IndexSyncResult> => {
    const results: SyncResult[] = [];
    const chats: IndexSyncResult['chats'] = [];
    const deliveries: IndexSyncResult['deliveries'] = [];
    for (const plugin of plugins) {
      const name = plugin.manifest.name;
      const backend = registry.create(config, name, backendContext(name, config));
      // The engine is chosen by the driver the backend implements, never by its name.
      if (isMailBackend(backend)) {
        results.push(
          await inPhase('mail', () =>
            syncIndex(db, backend, {
              accountId: params.accountId,
              folderPath: params.folder,
              fullScan: params.fullScan,
              onProgress: params.onProgress,
            }),
          ),
        );
      } else if (isChatBackend(backend)) {
        // `--folder` names a mailbox; a chat backend has none, so a folder-scoped run skips it.
        if (params.folder) continue;
        chats.push({
          backend: name,
          ...(await inPhase('chat', () =>
            syncChats(db, backend, {
              accountId: params.accountId,
              fullScan: params.fullScan,
              // A daemon following the account holds the lease: stand down for it.
              lease: {},
            }),
          )),
        });
      } else if (isDeliveryBackend(backend)) {
        if (params.folder) continue;
        // `--full-scan` has nothing to re-take here: a delivery-only network keeps no history.
        // An account a running daemon holds comes back with `heldBy` instead of an error: those
        // messages are arriving, so this run stands down for it (ADR 0002 §4).
        deliveries.push({
          backend: name,
          ...(await inPhase('delivery', () =>
            receiveDeliveries(db, backend, { accountId: params.accountId, mode: 'catch-up' }),
          )),
        });
      } else {
        throw new Error(
          fmt(_('backend {name} uses the {kind} driver, which this curlew cannot sync yet'), {
            name,
            kind: backend.kind,
          }),
        );
      }
    }
    const conversations = await inPhase('rebuild', () => rebuildWithAddressBook(db));
    const folders = results.flatMap((r) => r.folders);
    const chatAccounts = chats.flatMap((c) => c.accounts);
    const deliveryAccounts = deliveries.flatMap((d) => d.accounts);
    const errors =
      results.reduce((n, r) => n + r.errors, 0) +
      chats.reduce((n, c) => n + c.errors, 0) +
      deliveries.reduce((n, d) => n + d.errors, 0);
    const sources = folders.length + chatAccounts.length + deliveryAccounts.length;
    return {
      folders,
      added:
        results.reduce((n, r) => n + r.added, 0) +
        chats.reduce((n, c) => n + c.added, 0) +
        deliveries.reduce((n, d) => n + d.added, 0),
      updated: results.reduce((n, r) => n + r.updated, 0),
      removed:
        results.reduce((n, r) => n + r.removed, 0) +
        chats.reduce((n, c) => n + c.removed, 0) +
        deliveries.reduce((n, d) => n + d.removed, 0),
      errors,
      // An error overall only when every folder AND every chat account failed.
      failed: sources > 0 && errors === sources,
      backends,
      chats,
      deliveries,
      conversations,
    };
  };
  try {
    const held = await withIndexLease(db, params.holder ?? String(process.pid), run, params.leaseIntervalMs);
    if (held.ran) return held.value;
    // Stood down for the writer that has it: every count zero, nothing failed, and `heldBy` says
    // why. A frontend prints one line; the daemon's tick waits for the next one.
    return {
      folders: [],
      added: 0,
      updated: 0,
      removed: 0,
      errors: 0,
      failed: false,
      backends,
      chats: [],
      deliveries: [],
      conversations: { conversations: 0, messages: 0, participants: 0, contacts: null },
      heldBy: held.heldBy,
    };
  } finally {
    db.close();
  }
}

/** Report what the index holds and how fresh it is. */
export function indexStatus(dbPath?: string): SyncStatus & { path: string; maxStalenessHours: number } {
  const path = dbPath ?? indexDbPath();
  const db = openIndex(path);
  try {
    return {
      path,
      maxStalenessHours: MAX_STALENESS_HOURS,
      ...syncStatus(db, MAX_STALENESS_HOURS, new Date()),
    };
  } finally {
    db.close();
  }
}

/** Search the local index. Never writes — only `sync` does. */
export function indexSearch(
  criteria: IndexSearchCriteria,
  dbPath?: string,
  cfgPath = configPath(),
): { messages: IndexedMessage[]; staleFolders: number; indexedAt: string | null } {
  const config = loadConfig(cfgPath);
  const excludeAccounts = [...(criteria.excludeAccounts ?? []), ...hiddenAccountIds(config)];
  const chatOnlyAccounts = [...(criteria.chatOnlyAccounts ?? []), ...chatOnlyAccountIds(config)];
  const db = openIndex(dbPath ?? indexDbPath());
  try {
    const status = syncStatus(db, MAX_STALENESS_HOURS, new Date());
    return {
      messages: searchIndex(db, { ...criteria, excludeAccounts, chatOnlyAccounts }),
      staleFolders: status.staleFolders.length,
      indexedAt: status.newestSync,
    };
  } finally {
    db.close();
  }
}
