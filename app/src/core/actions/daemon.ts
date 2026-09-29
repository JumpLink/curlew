/**
 * `postbote daemon` — the receiving daemon (ADR 0002).
 *
 * A delivery-only backend (Signal, WhatsApp) has no server archive: the network forgets a message
 * once this device acknowledged it, so what this process writes is the only copy there will ever
 * be. That makes "sync every so often" a data-loss window, and WhatsApp unlinks a linked device
 * that stays away for about two weeks. A `sync` from a timer narrows the window; this closes it.
 *
 * What it does, and nothing else:
 *
 *   - receives from every ENABLED delivery-only backend, every account, `mode: 'follow'`, all at
 *     once (a follow session ends only when it is closed, so a queue would starve every account
 *     behind the first). Mail and chat backends stay on `postbote sync`: they are pull models
 *     with a cursor, and a daemon buys them nothing;
 *   - takes the receive lease per account, so a `sync` on the same account stands down — two
 *     devices on one account each acknowledge half the copy (`@postbote/store`);
 *   - reconnects a dropped session with backoff, and stops an account the network logged out;
 *   - rebuilds the conversations debounced, and once on stop, with the same address-book step
 *     `indexSync` uses;
 *   - logs one line per state change to stderr, where journald collects it. Never message text,
 *     chat titles, peer names or phone numbers — a log line is a file that gets copied around,
 *     and the index's privacy rule applies to it.
 *
 * The stop is the other half: `params.signal` aborts, every account's session is closed, every
 * loop is awaited (so the last batch is written and nothing unacknowledged is lost), the
 * conversations are rebuilt once, the database is closed, and the caller exits 0. A daemon that
 * was asked to stop did its job.
 */

import { type MessageBackend, isChatBackend, isDeliveryBackend, isMailBackend } from '@postbote/protocol';
import type { DeliveryProgress, DeliverySyncResult, IndexDatabase, RebuildResult } from '@postbote/store';
import { receiveDeliveries } from '@postbote/store';
import { builtinRegistry } from '../backends/builtin.ts';
import { backendContext } from '../backends/context.ts';
import { loadConfig } from '../config.ts';
import { configPath } from '@postbote/store';
import { openIndex, rebuildWithAddressBook } from './index-sync.ts';

/** How long the conversations wait for the last written batch before they are rebuilt. */
export const REBUILD_DEBOUNCE_MS = 30_000;

export interface DaemonParams {
  /** The index to write; the default is the user's. `:memory:` is a test's. */
  dbPath?: string;
  configPath?: string;
  /** Restrict to one account; omit for all. */
  accountId?: string;
  /** SIGTERM/SIGINT land here. The run ends normally — see the module comment. */
  signal?: AbortSignal;
  /** Short only in tests. */
  rebuildDebounceMs?: number;
  /** One line per state change; defaults to stderr. */
  log?: (line: string) => void;
  /**
   * The delivery backends to receive. Injected by tests; by default the ones the config enables,
   * chosen by the driver the backend implements — never by its name.
   */
  backends?: readonly MessageBackend[];
  /** Injected by tests; the address-book rebuild `indexSync` also uses. */
  rebuild?: (db: IndexDatabase) => Promise<RebuildResult & { contacts: number | null }>;
}

export interface DaemonAccountResult {
  backend: string;
  accountId: string;
  batches: number;
  added: number;
  removed: number;
  /** Set when this run stopped receiving: a logged-out device, an error, or a lost lease. */
  error: string | null;
  /** Set when ANOTHER holder has the account (a second daemon): this run left it alone. */
  heldBy: string | null;
  loggedOut: boolean;
}

export interface DaemonResult {
  backends: string[];
  accounts: DaemonAccountResult[];
  added: number;
  removed: number;
  errors: number;
  conversations: (RebuildResult & { contacts: number | null }) | null;
}

/** The enabled delivery-only backends — what a daemon receives and what a `sync` stands down for. */
export function deliveryBackends(config: ReturnType<typeof loadConfig>): MessageBackend[] {
  const registry = builtinRegistry();
  return registry
    .enabled(config)
    .map((plugin) =>
      registry.create(config, plugin.manifest.name, backendContext(plugin.manifest.name, config)),
    )
    .filter((backend) => isDeliveryBackend(backend));
}

/**
 * The process exit code of a finished run.
 *
 * `2` when the run ended with nothing left to receive AND at least one account ended `loggedOut`:
 * the network dropped this device (WhatsApp's ~14-day unlink), a restart cannot relink it, and
 * `Restart=on-failure` would only hammer the network — so systemd is told NOT to restart
 * (`RestartPreventExitStatus=2`) and the unit shows as **failed**, which is the only signal that
 * says "nothing is being received and you have to link the device again".
 *
 * Everything else is `0`, including a normal SIGTERM stop, a run that is still receiving on
 * another account, and a machine with no linked account at all: a daemon that was asked to stop
 * did its job, and a non-zero code on a clean stop would restart-loop.
 */
export function daemonExitCode(run: Pick<DaemonResult, 'accounts'>): 0 | 2 {
  const dead = (account: DaemonAccountResult): boolean =>
    account.loggedOut || account.heldBy !== null || account.error !== null;
  if (run.accounts.length > 0 && run.accounts.every(dead) && run.accounts.some((a) => a.loggedOut)) {
    return 2;
  }
  return 0;
}

/** One log line. Names, counts and timings only — never anything a peer wrote. */
function line(event: DeliveryProgress, log: (line: string) => void): void {
  const who = `${event.backend}/${event.accountId}`;
  switch (event.type) {
    case 'connected':
      return log(`postbote-daemon: ${who} connected`);
    case 'batch':
      return log(
        `postbote-daemon: ${who} batch ${event.batches} written ` +
          `(added ${event.added}, edited ${event.edited}, removed ${event.removed})`,
      );
    case 'reconnect':
      return log(`postbote-daemon: ${who} reconnect in ${event.delayMs} ms (attempt ${event.attempt})`);
    case 'logged-out':
      return log(
        `postbote-daemon: ${who} logged out — link the device again${event.error ? ` (${event.error})` : ''}`,
      );
    case 'lease-held':
      return log(`postbote-daemon: ${who} is held by ${event.holder} — not receiving it here`);
    case 'lease-waiting':
      return log(
        `postbote-daemon: ${who} is held by ${event.holder ?? 'another process'} — waiting for the lease`,
      );
    case 'lease-lost':
      return log(`postbote-daemon: ${who} lost the receive lease — stopping that account`);
    case 'stopped':
      return log(`postbote-daemon: ${who} stopped (${event.reason})`);
  }
}

/**
 * Receive until `params.signal` aborts, then rebuild the conversations once and close the index.
 *
 * The promise resolves when EVERY account loop has ended — not when the signal arrived — so the
 * caller can close the database knowing no write is still in flight.
 */
export async function runDeliveryDaemon(params: DaemonParams = {}): Promise<DaemonResult> {
  const log = params.log ?? ((text: string) => console.error(text));
  const config = loadConfig(params.configPath ?? configPath());
  const backends = (params.backends ?? deliveryBackends(config)).filter((backend) => {
    if (isDeliveryBackend(backend)) return true;
    // A mail or chat backend here would be a mistake in the caller, not a runtime condition to
    // discover after it connected: those models belong on `postbote sync`.
    if (isMailBackend(backend) || isChatBackend(backend)) {
      log(
        `postbote-daemon: skipping ${backend.manifest.name} — a ${backend.manifest.syncModel} backend is served by \`postbote sync\``,
      );
      return false;
    }
    return true;
  });
  if (backends.length === 0) {
    throw new Error(
      'no delivery-only backend is enabled — `postbote backends list` shows them; the daemon receives Signal and WhatsApp, `postbote sync` stays for mail and chat',
    );
  }

  const db = openIndex(params.dbPath);
  const rebuild = params.rebuild ?? rebuildWithAddressBook;
  const debounce = params.rebuildDebounceMs ?? REBUILD_DEBOUNCE_MS;
  // Conversations are derived from what was written, so they are rebuilt when the writes stop —
  // a burst of batches is one rebuild, not one per batch (ADR 0002 §5).
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let conversations: (RebuildResult & { contacts: number | null }) | null = null;
  const rebuildNow = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    dirty = false;
    conversations = await rebuild(db);
    log(
      `postbote-daemon: conversations rebuilt (${conversations.conversations} conversations, ` +
        `${conversations.participants} participants)`,
    );
  };
  const schedule = (): void => {
    dirty = true;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void rebuildNow().catch((err: unknown) =>
        log(`postbote-daemon: the conversations could not be rebuilt: ${errText(err)}`),
      );
    }, debounce);
  };

  const signal = params.signal ?? new AbortController().signal;
  try {
    log(
      `postbote-daemon: receiving from ${backends.map((b) => b.manifest.name).join(', ')} ` +
        `(${params.accountId ?? 'every account'}) — stop with SIGTERM`,
    );
    const results = await Promise.all(
      backends.map(
        async (backend): Promise<DeliverySyncResult> =>
          receiveDeliveries(db, backend as Parameters<typeof receiveDeliveries>[1], {
            mode: 'follow',
            signal,
            accountId: params.accountId,
            onProgress: (event) => {
              if (event.type === 'batch') schedule();
              line(event, log);
            },
          }),
      ),
    );
    // On stop: the last writes are in, and the derived tables are rebuilt before the DB closes.
    if (dirty) await rebuildNow();
    else if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const accounts: DaemonAccountResult[] = results.flatMap((r) =>
      r.accounts.map((a) => ({
        backend: a.backend,
        accountId: a.accountId,
        batches: a.batches,
        added: a.added,
        removed: a.removed,
        error: a.error,
        heldBy: a.heldBy ?? null,
        loggedOut: a.loggedOut === true,
      })),
    );
    const errors = accounts.filter((a) => a.error !== null).length;
    log(
      `postbote-daemon: stopped — ${accounts.length} account(s), ${accounts.reduce((n, a) => n + a.added, 0)} message(s) received, ${errors} error(s)`,
    );
    return {
      backends: backends.map((b) => b.manifest.name),
      accounts,
      added: results.reduce((n, r) => n + r.added, 0),
      removed: results.reduce((n, r) => n + r.removed, 0),
      errors,
      conversations,
    };
  } finally {
    db.close();
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
