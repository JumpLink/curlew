/**
 * Small helpers for code that waits and reports failures, shared so each caller does not carry
 * its own copy.
 */

/** The message of an error, or the value stringified when something other than an Error was thrown. */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wait `ms`, but stop waiting early when `signal` aborts. Never rejects: an abort ends the wait,
 * and the caller checks the signal itself. Without a signal it is a plain timer.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
