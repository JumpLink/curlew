import { describe, expect, it } from '@gjsify/unit';

import { DEFAULT_BUDGET_MS, idleBudget, stepQueue } from '../../../src/window/idle-work-model.ts';

/** A clock the test moves by hand, so the budget is tested and not the machine's speed. */
function clock(): { now: () => number; tick: (ms: number) => void } {
  let at = 0;
  return { now: () => at, tick: (ms) => void (at += ms) };
}

export default async () => {
  describe('the time-sliced idle worker', () => {
    it('runs the whole queue when every step is free', () => {
      const { now } = clock();
      const ran: number[] = [];
      const queue = stepQueue([1, 2, 3].map((n) => () => ran.push(n)));
      expect(queue.pump(now)).toBe(false);
      expect(ran).toStrictEqual([1, 2, 3]);
      expect(queue.remaining).toBe(0);
    });

    it('stops the turn once the budget is spent and keeps the rest', () => {
      const { now, tick } = clock();
      const ran: number[] = [];
      const queue = stepQueue(
        [1, 2, 3, 4].map((n) => () => {
          ran.push(n);
          tick(3);
        }),
      );
      // Two steps fit a 4 ms budget: after the first the clock is at 3, under budget; after the
      // second at 6, over it.
      expect(queue.pump(now, 4)).toBe(true);
      expect(ran).toStrictEqual([1, 2]);
      expect(queue.remaining).toBe(2);
      expect(queue.pump(now, 4)).toBe(false);
      expect(ran).toStrictEqual([1, 2, 3, 4]);
    });

    it('always runs one step, however slow it is', () => {
      // A queue whose first step is slower than the whole budget must still advance, or the
      // window would come back to the same step every turn and never finish.
      const { now, tick } = clock();
      const ran: string[] = [];
      const queue = stepQueue([
        () => {
          ran.push('slow');
          tick(500);
        },
        () => ran.push('next'),
      ]);
      expect(queue.pump(now, 4)).toBe(true);
      expect(ran).toStrictEqual(['slow']);
    });

    it('is finished when there is nothing to do', () => {
      const { now } = clock();
      const queue = stepQueue([]);
      expect(queue.pump(now)).toBe(false);
      expect(queue.remaining).toBe(0);
    });

    it('takes the budget from the environment only when it is a positive number', () => {
      expect(idleBudget({})).toBe(DEFAULT_BUDGET_MS);
      expect(idleBudget({ CURLEW_IDLE_BUDGET_MS: 'x' })).toBe(DEFAULT_BUDGET_MS);
      expect(idleBudget({ CURLEW_IDLE_BUDGET_MS: '0' })).toBe(DEFAULT_BUDGET_MS);
      expect(idleBudget({ CURLEW_IDLE_BUDGET_MS: '-5' })).toBe(DEFAULT_BUDGET_MS);
      expect(idleBudget({ CURLEW_IDLE_BUDGET_MS: '12' })).toBe(12);
    });

    it('keeps the default well under one frame', () => {
      // The budget is paid before GTK lays out what the turn built, and twice in a chained run.
      expect(DEFAULT_BUDGET_MS).toBeLessThanOrEqual(15);
    });
  });
};
