/**
 * The one fake clock both receive suites drive their time caps with. It moves only when told to, so
 * a cap that is minutes long in production costs no wall-clock time in a test: a run under test
 * hands its `setTimer`/`clearTimer` here, and the test crosses the cap with `advance()`.
 *
 * Shared rather than copied per suite: it lives in `app/tests`, which both suites already belong to
 * and which imports every backend anyway. The AGENTS.md rule that WhatsApp may not share a helper
 * exists to keep the *package* importable on its own — it says nothing about test fakes, and nothing
 * here is reachable from `packages/whatsapp` or any other package.
 */
export class ManualClock {
  private at = 0;
  private next = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  readonly set = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.set(id, { at: this.at + ms, fn });
    return id;
  };

  readonly clear = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  pending(): number {
    return this.timers.size;
  }

  /** Move forward, firing every timer that falls due, in order. */
  advance(ms: number): void {
    const until = this.at + ms;
    for (;;) {
      const due = [...this.timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.at = due[1].at;
      due[1].fn();
    }
    this.at = until;
  }
}

/** One macrotask: whatever was queued with setTimeout has run by then. */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
