/**
 * `CURLEW_DEBUG_STALL=1` logs every moment the GLib main loop was blocked for longer than the
 * threshold (default 50 ms, `CURLEW_DEBUG_STALL_MS`), and `timed()` names the work that did it.
 * Off by default: no timer runs and `timed()` is a plain call.
 */

import GLib from 'gi://GLib?version=2.0';

import { isStall, stallProbeEnabled, stallThreshold } from './stall-probe-model.ts';

const TICK_MS = 16;

/** When this process started, near enough: the module loads before the window is built. */
const ORIGIN = GLib.get_monotonic_time();

/**
 * Milliseconds since the process started. Every line the probe writes carries one, and so do the
 * window's own milestones, because a reader cannot otherwise tell WHEN a block happened: a block
 * is reported by the tick that follows it, so the line lands after whatever ran during it --
 * including the milestone that ends cold start. Line order puts such a block on the wrong side of
 * the boundary; the stamp puts it where it began (dev/perf-report.mjs).
 */
export function sinceStart(): number {
  return (GLib.get_monotonic_time() - ORIGIN) / 1000;
}

export function startStallProbe(env: NodeJS.ProcessEnv = process.env): void {
  if (!stallProbeEnabled(env)) return;
  const threshold = stallThreshold(env);
  let last = sinceStart();
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
    const now = sinceStart();
    const late = now - last - TICK_MS;
    // The block began when this tick was due and did not run, not when it finally did.
    if (isStall(late, threshold))
      console.log(`[stall] main loop blocked ${late.toFixed(0)} ms at ${(last + TICK_MS).toFixed(0)}`);
    last = now;
    return GLib.SOURCE_CONTINUE;
  });
}

/** Run `work`, and log its duration when the probe is on. */
export function timed<T>(label: string, work: () => T): T {
  if (!stallProbeEnabled(process.env)) return work();
  const start = sinceStart();
  try {
    return work();
  } finally {
    console.log(`[stall] ${label}: ${(sinceStart() - start).toFixed(1)} ms at ${start.toFixed(0)}`);
  }
}
