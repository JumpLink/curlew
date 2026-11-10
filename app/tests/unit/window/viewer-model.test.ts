import { describe, expect, it } from '@gjsify/unit';

import { albumPosition, albumStep, swipeStep } from '../../../src/window/viewer-model.ts';

export default async () => {
  await describe('albumStep', async () => {
    await it('moves within the album and stops at both ends', async () => {
      expect(albumStep(1, 4, 1)).toBe(2);
      expect(albumStep(1, 4, -1)).toBe(0);
      expect(albumStep(3, 4, 1)).toBe(null);
      expect(albumStep(0, 4, -1)).toBe(null);
      expect(albumStep(0, 1, 1)).toBe(null);
    });
  });

  await describe('albumPosition', async () => {
    await it('counts from one and is empty for a single item', async () => {
      expect(albumPosition(1, 4)).toBe('2 / 4');
      expect(albumPosition(0, 1)).toBe('');
    });
  });

  await describe('swipeStep', async () => {
    await it('maps a horizontal swipe to a direction', async () => {
      expect(swipeStep(-900, 20)).toBe(1);
      expect(swipeStep(900, -20)).toBe(-1);
    });

    await it('ignores slow and mostly vertical gestures', async () => {
      expect(swipeStep(-100, 0)).toBe(0);
      expect(swipeStep(-500, 900)).toBe(0);
      expect(swipeStep(0, 0)).toBe(0);
    });
  });
};
