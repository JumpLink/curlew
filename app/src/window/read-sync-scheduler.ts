import { errorMessage } from '@curlew/protocol';
/**
 * Debounce for pushing the read position to the person's own devices (#441): one pending sync
 * per conversation, run once the position has been quiet for `delayMs`. A failure is logged and
 * never shown; the next change schedules it again.
 */

export const READ_SYNC_DELAY_MS = 2000;

export interface ReadSyncTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ReadSyncScheduler {
  /** (Re)start the countdown for `key`; `run` fires when it elapses undisturbed. */
  schedule(key: string, run: () => Promise<unknown>): void;
  /** Drop every pending sync. */
  cancelAll(): void;
}

export function createReadSyncScheduler(
  timers: ReadSyncTimers,
  log: (line: string) => void,
  delayMs = READ_SYNC_DELAY_MS,
): ReadSyncScheduler {
  const pending = new Map<string, unknown>();
  return {
    schedule(key, run) {
      const old = pending.get(key);
      if (old !== undefined) timers.clear(old);
      pending.set(
        key,
        timers.set(() => {
          pending.delete(key);
          run().catch((error: unknown) => {
            log(`read sync for ${key} failed: ${errorMessage(error)}`);
          });
        }, delayMs),
      );
    },
    cancelAll() {
      for (const handle of pending.values()) timers.clear(handle);
      pending.clear();
    },
  };
}
