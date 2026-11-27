/**
 * The pure half of the time-sliced idle worker (`idle-work.ts`), testable without GLib.
 *
 * The problem it solves, measured on a synthetic index of 10 500 conversations (#501): work that
 * is already cut into idle batches of a FIXED COUNT still blocks the loop, because the cost of a
 * batch is not the count. Building 40 conversation rows took 25 ms on this workstation and over
 * 50 ms once GTK's layout pass for the new rows is counted — and a phone is slower still. A
 * batch therefore ends on a CLOCK, not on a count: each turn runs steps until its budget is
 * spent, so one slow step costs one slow turn instead of a frozen window.
 */

/**
 * How long one turn may hold the main loop. Well under the 50 ms stall budget (ADR 0149), because
 * the widgets a turn creates still have to be laid out and drawn after it returns, and that pass
 * lands in the same frame.
 *
 * Measured, not guessed: a refresh runs the first turn of two chained runs inline, so the budget
 * is paid twice in the dispatch the person is waiting on. At 8 ms that was 21 ms of a 51 ms
 * block; at 4 ms it is 11 ms and the block is gone (`dev/perf.sh --only switch`). Going lower
 * does not help -- the fill then needs so many turns that GTK lays out a part-filled list again
 * and again.
 */
export const DEFAULT_BUDGET_MS = 4;

/** A queue of steps that runs against an injected clock. */
export interface StepQueue {
  /**
   * Run steps until the budget is spent or the queue is empty, always at least one (a queue that
   * never advances would spin forever). Returns whether steps remain.
   */
  pump(nowMs: () => number, budgetMs?: number): boolean;
  /** Steps not yet run. */
  readonly remaining: number;
}

/** A queue over `steps`, in order. */
export function stepQueue(steps: ReadonlyArray<() => void>): StepQueue {
  let next = 0;
  return {
    pump(nowMs, budgetMs = DEFAULT_BUDGET_MS) {
      if (next >= steps.length) return false;
      const start = nowMs();
      do {
        steps[next++]!();
      } while (next < steps.length && nowMs() - start < budgetMs);
      return next < steps.length;
    },
    get remaining() {
      return steps.length - next;
    },
  };
}

/** `CURLEW_IDLE_BUDGET_MS` when it is a positive number, else the default. For the perf harness. */
export function idleBudget(env: NodeJS.ProcessEnv): number {
  const value = Number(env.CURLEW_IDLE_BUDGET_MS);
  return value > 0 ? value : DEFAULT_BUDGET_MS;
}
