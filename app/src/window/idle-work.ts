/**
 * Run a list of steps across main-loop turns, each turn bounded by a time budget rather than a
 * step count — see `idle-work-model.ts` for why the clock and not the count decides.
 *
 * gjsify gap (unfixed, gjsify/gjsify#2765): every GJS app with a long list needs this, and it is
 * not Curlew's to own. When gjsify ships a time-sliced scheduler, this file becomes a re-export
 * and the two callers below keep their shape.
 */

import GLib from 'gi://GLib?version=2.0';

import { idleBudget, stepQueue } from './idle-work-model.ts';
import { timed } from './stall-probe.ts';

const now = (): number => GLib.get_monotonic_time() / 1000;

/** Stops the run; safe to call after it finished. */
export type CancelWork = () => void;

/**
 * Run `steps` in budgeted turns on the idle queue. The first turn runs INLINE, so the window
 * never paints an empty list it could have filled: what fits in one budget is there at once and
 * the rest follows. `done` runs after the last step.
 */
export function runChunked(steps: ReadonlyArray<() => void>, done?: () => void): CancelWork {
  const queue = stepQueue(steps);
  const budget = idleBudget(process.env);
  let source = 0;
  let cancelled = false;
  // Each turn is named, so the responsiveness gate sees it. A turn is the one piece of the
  // window's work that does NOT show up inside a caller's own measurement -- `set entries` has
  // returned by the time the second turn runs -- and a turn that overruns its budget is a freeze
  // like any other (dev/perf-report.mjs enforces the named work everywhere).
  const turn = (): boolean => timed('idle turn', () => queue.pump(now, budget));
  if (!turn()) {
    done?.();
    return () => {};
  }
  source = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    if (cancelled) return GLib.SOURCE_REMOVE;
    if (turn()) return GLib.SOURCE_CONTINUE;
    source = 0;
    done?.();
    return GLib.SOURCE_REMOVE;
  });
  return () => {
    cancelled = true;
    if (source !== 0) GLib.source_remove(source);
    source = 0;
  };
}
