/**
 * The periodic pull sync — mail and the pull-model chats, on a timer owned by whichever process
 * is already running (ADR 0002 §8): `curlew daemon` where there is a background service, the
 * window itself where there is none. A GUI-only install (Flatpak, a phone, Windows, macOS) has
 * no terminal to type `curlew sync` into and no timer unless somebody installed one by hand.
 *
 * The ticker is here, shared, because the two rules it implements are the same for both hosts and
 * both are about never having two index writers:
 *
 *   - one tick at a time. A tick that arrives while the previous one is still going is SKIPPED,
 *     not queued: a sync of several mail accounts can outlast the interval, and a queue would
 *     collect ticks and then run them back to back forever.
 *   - the stop waits for a tick in flight. `db.close()` under a running sync tears the handle out
 *     from under a run that is mid-batch, and that batch is a write that was already fetched.
 *
 * Across processes the lock is the index-writer lease (`withIndexLease`), not this ticker: a
 * `curlew sync` typed by hand — or the `curlew-sync.timer` of an older install — stands down for
 * the tick and the tick stands down for it.
 */

import { errText } from '@curlew/protocol';

/**
 * How often the pull sync runs — the interval `contrib/systemd/curlew-sync.timer` used, because
 * that is what it replaces for a GUI-only install. A constant and not a config key: the number
 * that matters to a person is "mail arrives by itself", and a key would be a second place to look
 * when it does not.
 */
export const PULL_SYNC_INTERVAL_MS = 15 * 60_000;

/**
 * How long after start the first pull sync runs. Not immediately: the delivery connections and
 * the follow loops are coming up in the same seconds, and a mail sync of several accounts holds
 * the index's write path for minutes — the live sessions get the index first.
 */
export const PULL_SYNC_START_DELAY_MS = 20_000;

export interface PullSyncTicker {
  /** Stop ticking and resolve once a sync in flight has finished. Safe to call twice. */
  stop(): Promise<void>;
}

export interface PullSyncParams {
  /** One pass. It reports its own result; a rejection is logged here and the ticker goes on. */
  run: () => Promise<void>;
  /** One line per state change. */
  log: (line: string) => void;
  /** What the log lines are attributed to, e.g. `curlew-daemon`. */
  who: string;
  /** Ends the ticking; a tick already in flight still finishes. */
  signal?: AbortSignal;
  /** Short only in tests: how long until the first sync. */
  delayMs?: number;
  /** Short only in tests: how long between syncs. */
  intervalMs?: number;
}

/** The parts of a sync result that name a failed source; structural, so this module stays free of the store. */
export interface PullSyncOutcome {
  folders: ReadonlyArray<{ accountId: string; folderPath: string; error: string | null }>;
  chats: ReadonlyArray<{ backend: string; accounts: ReadonlyArray<{ accountId: string; error: string | null }> }>;
  deliveries: ReadonlyArray<{
    backend: string;
    accounts: ReadonlyArray<{ accountId: string; error: string | null }>;
  }>;
}

/**
 * One line per failed source of a pull sync. The summary line only counts errors, and a count
 * that repeats every 15 minutes with nothing behind it cannot be followed up.
 */
export function pullSyncFailures(result: PullSyncOutcome): string[] {
  const lines: string[] = [];
  for (const f of result.folders) if (f.error) lines.push(`mail/${f.accountId} ${f.folderPath}: ${f.error}`);
  for (const group of [...result.chats, ...result.deliveries])
    for (const a of group.accounts) if (a.error) lines.push(`${group.backend}/${a.accountId}: ${a.error}`);
  return lines;
}

/** Start the pull sync timer. Nothing runs before `delayMs` has passed. */
export function startPullSync(params: PullSyncParams): PullSyncTicker {
  const { run, log, who, signal } = params;
  const interval = params.intervalMs ?? PULL_SYNC_INTERVAL_MS;
  const delay = params.delayMs ?? PULL_SYNC_START_DELAY_MS;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = (): void => {
    timer = null;
    if (signal?.aborted) return;
    if (inFlight !== null) {
      log(`${who}: the previous pull sync is still running — skipping this tick`);
    } else {
      const next = run()
        .catch((err: unknown) => log(`${who}: the pull sync failed: ${errText(err)}`))
        .finally(() => {
          if (inFlight === next) inFlight = null;
        });
      inFlight = next;
    }
    timer = setTimeout(tick, interval);
  };
  if (!signal?.aborted) timer = setTimeout(tick, delay);
  return {
    stop: async () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      while (inFlight !== null) await inFlight;
    },
  };
}
