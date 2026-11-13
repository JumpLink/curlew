/** The pure half of the main-loop stall probe (`stall-probe.ts`), testable without GLib. */

export const DEFAULT_STALL_MS = 50;

export const stallProbeEnabled = (env: NodeJS.ProcessEnv): boolean => env.CURLEW_DEBUG_STALL === '1';

/** `CURLEW_DEBUG_STALL_MS` when it is a positive number, else the default. */
export function stallThreshold(env: NodeJS.ProcessEnv): number {
  const value = Number(env.CURLEW_DEBUG_STALL_MS);
  return value > 0 ? value : DEFAULT_STALL_MS;
}

/** Whether a tick that arrived `lateMs` after it was due counts as a stall. */
export const isStall = (lateMs: number, thresholdMs: number): boolean => lateMs > thresholdMs;
