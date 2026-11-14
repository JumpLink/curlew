/**
 * Receiving inside the window, for platforms with no background service (`backgroundService` is
 * `while-open`). The same receive loop `curlew daemon` runs, started when the window opens and
 * stopped, with the last batch written, when it closes. The loop is injected so a test needs no
 * network and the core never imports the daemon action.
 */

import { backgroundService, type PlatformName } from '../platform.ts';

export interface InProcessReceiver {
  /** Ask the loop to end and resolve once its last batch is written. */
  stop(): Promise<void>;
}

export type ReceiveLoop = (params: { signal: AbortSignal; log: (line: string) => void }) => Promise<unknown>;

/**
 * Start the loop when this platform has no background service; `null` elsewhere, where the daemon
 * is the only receiver (two receivers on one account would each acknowledge half the copy).
 */
export function hostReceiveLoop(
  platform: PlatformName,
  run: ReceiveLoop,
  log: (line: string) => void = () => {},
): InProcessReceiver | null {
  if (backgroundService(platform) !== 'while-open') return null;
  const controller = new AbortController();
  const done = run({ signal: controller.signal, log }).catch((error: unknown) => {
    // "Nothing to receive" is the normal state of a window without chat accounts.
    log(`curlew-window: receiving ended: ${error instanceof Error ? error.message : String(error)}`);
  });
  return {
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}
