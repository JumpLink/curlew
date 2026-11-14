import { describe, expect, it } from '@gjsify/unit';

import {
  PULL_SYNC_INTERVAL_MS,
  PULL_SYNC_START_DELAY_MS,
  startPullSync,
} from '../../../src/core/lib/pull-sync.ts';

/**
 * The pull-sync ticker on its own, with no index behind it: the two rules that keep a second
 * index writer out of one process — one tick at a time, and a stop that waits for the tick in
 * flight. The cross-process half of that is the index-writer lease and belongs to
 * `index-sync`, not here.
 */

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export default async () => {
  await describe('the pull sync ticker', async () => {
    await it('runs nothing before the start delay has passed', async () => {
      let runs = 0;
      const ticker = startPullSync({
        run: async () => {
          runs++;
        },
        log: () => {},
        who: 'test',
        delayMs: 10_000,
      });
      await wait(5);
      expect(runs).toBe(0);
      await ticker.stop();
      await wait(5);
      expect(runs).toBe(0);
    });

    await it('keeps the interval the sync timer used', () => {
      expect(PULL_SYNC_INTERVAL_MS).toBe(15 * 60_000);
      expect(PULL_SYNC_START_DELAY_MS < PULL_SYNC_INTERVAL_MS).toBe(true);
    });

    await it('skips a tick instead of queueing it while a sync is still running', async () => {
      let started = 0;
      let peak = 0;
      let running = 0;
      const logs: string[] = [];
      let open: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const ticker = startPullSync({
        run: async () => {
          started++;
          running++;
          peak = Math.max(peak, running);
          await gate;
          running--;
        },
        log: (line) => logs.push(line),
        who: 'test',
        delayMs: 1,
        intervalMs: 1,
      });
      // Several intervals pass while the first sync is held: a queue would collect them all and
      // then run them back to back for good.
      await wait(20);
      expect(started).toBe(1);
      expect(peak).toBe(1);
      expect(logs.some((l) => l.includes('still running — skipping this tick'))).toBe(true);
      open();
      await ticker.stop();
      expect(peak).toBe(1);
    });

    await it('waits for the sync in flight when it is stopped', async () => {
      let finished = false;
      let open: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const ticker = startPullSync({
        run: async () => {
          await gate;
          finished = true;
        },
        log: () => {},
        who: 'test',
        delayMs: 1,
        intervalMs: 1_000,
      });
      await wait(10);
      let stopped = false;
      const stopping = ticker.stop().then(() => {
        stopped = true;
      });
      await wait(5);
      // The caller closes the index as soon as `stop()` resolves, so it must not resolve yet.
      expect(stopped).toBe(false);
      expect(finished).toBe(false);
      open();
      await stopping;
      expect(finished).toBe(true);
      // Twice is allowed: the daemon stops it before the rebuild flush and again in `finally`.
      await ticker.stop();
    });

    await it('logs a failed sync and goes on ticking', async () => {
      let runs = 0;
      const logs: string[] = [];
      const ticker = startPullSync({
        run: async () => {
          runs++;
          throw new Error('the index is locked');
        },
        log: (line) => logs.push(line),
        who: 'test',
        delayMs: 1,
        intervalMs: 1,
      });
      await wait(20);
      await ticker.stop();
      expect(runs > 1).toBe(true);
      expect(logs.some((l) => l.includes('the pull sync failed: the index is locked'))).toBe(true);
    });

    await it('never starts when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      let runs = 0;
      const ticker = startPullSync({
        run: async () => {
          runs++;
        },
        log: () => {},
        who: 'test',
        signal: controller.signal,
        delayMs: 1,
        intervalMs: 1,
      });
      await wait(10);
      await ticker.stop();
      expect(runs).toBe(0);
    });
  });
};
