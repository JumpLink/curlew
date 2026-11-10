import { describe, expect, it } from '@gjsify/unit';

import { type CachedPart, pickEvictions } from '../../../src/window/preview-cache-model.ts';

const part = (name: string, bytes: number, modified: number): CachedPart => ({ name, bytes, modified });

export default async () => {
  await describe('pickEvictions', async () => {
    await it('drops nothing while the cache fits', async () => {
      expect(pickEvictions([part('a', 40, 1), part('b', 60, 2)], 100)).toStrictEqual([]);
    });

    await it('drops the oldest first, and only as many as needed', async () => {
      const parts = [part('new', 50, 30), part('old', 50, 10), part('mid', 50, 20)];
      expect(pickEvictions(parts, 100)).toStrictEqual(['old']);
      expect(pickEvictions(parts, 60)).toStrictEqual(['old', 'mid']);
    });

    await it('never drops a kept part, even if it alone is over the cap', async () => {
      const parts = [part('big', 500, 1), part('other', 10, 2)];
      expect(pickEvictions(parts, 100, ['big'])).toStrictEqual(['other']);
    });

    await it('does not mutate its input order', async () => {
      const parts = [part('b', 10, 2), part('a', 10, 1)];
      pickEvictions(parts, 5);
      expect(parts.map((p) => p.name)).toStrictEqual(['b', 'a']);
    });
  });
};
