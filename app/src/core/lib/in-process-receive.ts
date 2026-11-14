/**
 * Receiving inside the window, for platforms with no background service (`backgroundService` is
 * `while-open`). The same receive loop `curlew daemon` runs, started when the window opens and
 * stopped, with the last batch written, when it closes. The loop is injected so a test needs no
 * network and the core never imports the daemon action.
 *
 * The periodic pull sync comes with it (ADR 0002 §8): on those platforms there is no daemon and
 * no timer, so the window is the process that has to run it, and the receive loop ending — a
 * window with mail accounts only has nothing to receive — must not take the sync down with it.
 */

import { backgroundService, type PlatformName } from '../platform.ts';
import { startPullSync, type PullSyncTicker } from './pull-sync.ts';

export interface InProcessReceiver {
  /** Ask the loop to end and resolve once its last batch is written. */
  stop(): Promise<void>;
}

export type ReceiveLoop = (params: { signal: AbortSignal; log: (line: string) => void }) => Promise<unknown>;

export interface HostReceiveOptions {
  /**
   * One pass of the pull sync — `indexSync`, i.e. exactly what `curlew sync` runs. Omitted, the
   * window only receives, which is what a test and the demo want.
   */
  pullSync?: () => Promise<unknown>;
  /** Short only in tests: how long until the first pull sync. */
  pullSyncDelayMs?: number;
  /** Short only in tests: how long between pull syncs. */
  pullSyncIntervalMs?: number;
}

/**
 * Start the loop when this platform has no background service; `null` elsewhere, where the daemon
 * is the only receiver (two receivers on one account would each acknowledge half the copy).
 */
export function hostReceiveLoop(
  platform: PlatformName,
  run: ReceiveLoop,
  log: (line: string) => void = () => {},
  options: HostReceiveOptions = {},
): InProcessReceiver | null {
  if (backgroundService(platform) !== 'while-open') return null;
  const controller = new AbortController();
  const done = run({ signal: controller.signal, log }).catch((error: unknown) => {
    // "Nothing to receive" is the normal state of a window without chat accounts.
    log(`curlew-window: receiving ended: ${error instanceof Error ? error.message : String(error)}`);
  });
  const pull: PullSyncTicker | null =
    options.pullSync === undefined
      ? null
      : startPullSync({
          run: async () => {
            await options.pullSync!();
          },
          log,
          who: 'curlew-window',
          signal: controller.signal,
          delayMs: options.pullSyncDelayMs,
          intervalMs: options.pullSyncIntervalMs,
        });
  return {
    stop: async () => {
      controller.abort();
      // Both, and the sync first: it writes the index the receive loop's last batch also writes,
      // and the window closes its handle as soon as this resolves.
      await pull?.stop();
      await done;
    },
  };
}
