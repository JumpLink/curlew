import { describe, expect, it } from '@gjsify/unit';

import { createRestartCoalescer } from '../../../src/core/lib/restart-coalescer.ts';
import { until } from '../wait.ts';

export default async () => {
  await describe('restart coalescer', async () => {
    await it('never runs two restarts at once and collapses a burst into one more', async () => {
      let active = 0;
      let overlap = false;
      let runs = 0;
      const restart = createRestartCoalescer(async () => {
        runs += 1;
        active += 1;
        if (active > 1) overlap = true;
        await new Promise((r) => setTimeout(r, 30));
        active -= 1;
      });
      restart();
      restart();
      restart();
      await until(() => runs === 2 && active === 0);
      await new Promise((r) => setTimeout(r, 60));
      expect(runs).toBe(2);
      expect(overlap).toBe(false);
    });

    await it('survives a failing restart and still runs the next one', async () => {
      let runs = 0;
      const restart = createRestartCoalescer(async () => {
        runs += 1;
        throw new Error('no systemd');
      });
      restart();
      await until(() => runs === 1);
      await new Promise((r) => setTimeout(r, 10));
      restart();
      await until(() => runs === 2);
      expect(runs).toBe(2);
    });
  });
};
