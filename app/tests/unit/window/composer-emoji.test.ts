import { describe, expect, it } from '@gjsify/unit';

import { QUICK_REACTIONS } from '../../../src/window/conversation-model.ts';

export default async () => {
  await describe('quick reactions', async () => {
    await it('offers a short row of distinct emoji', async () => {
      expect(QUICK_REACTIONS.length).toBeGreaterThan(0);
      expect(QUICK_REACTIONS.length).toBeLessThanOrEqual(8);
      expect(new Set(QUICK_REACTIONS).size).toBe(QUICK_REACTIONS.length);
    });
  });
};
