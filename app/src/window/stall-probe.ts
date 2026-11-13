/**
 * `CURLEW_DEBUG_STALL=1` logs every moment the GLib main loop was blocked for longer than the
 * threshold (default 50 ms, `CURLEW_DEBUG_STALL_MS`), and `timed()` names the work that did it.
 * Off by default: no timer runs and `timed()` is a plain call.
 */

import GLib from 'gi://GLib?version=2.0';

import { isStall, stallProbeEnabled, stallThreshold } from './stall-probe-model.ts';

const TICK_MS = 16;

export function startStallProbe(env: NodeJS.ProcessEnv = process.env): void {
  if (!stallProbeEnabled(env)) return;
  const threshold = stallThreshold(env);
  let last = GLib.get_monotonic_time() / 1000;
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
    const now = GLib.get_monotonic_time() / 1000;
    const late = now - last - TICK_MS;
    if (isStall(late, threshold)) console.log(`[stall] main loop blocked ${late.toFixed(0)} ms`);
    last = now;
    return GLib.SOURCE_CONTINUE;
  });
}

/** Run `work`, and log its duration when the probe is on. */
export function timed<T>(label: string, work: () => T): T {
  if (!stallProbeEnabled(process.env)) return work();
  const start = GLib.get_monotonic_time();
  try {
    return work();
  } finally {
    console.log(`[stall] ${label}: ${((GLib.get_monotonic_time() - start) / 1000).toFixed(1)} ms`);
  }
}
