import { describe, expect, it } from '@gjsify/unit';

import { parseConfig } from '../../../src/core/config.ts';
import { pickPlaying, silentVideosOn } from '../../../src/window/video-preview-model.ts';

export default async () => {
  await describe('silent video preview choice', async () => {
    await it('plays nothing when no preview is half on screen', async () => {
      expect(pickPlaying([{ id: 1, visible: 0.49, distance: 0 }], null)).toBe(null);
      expect(pickPlaying([], null)).toBe(null);
    });

    await it('picks the preview nearest the middle among the ones on screen', async () => {
      const picked = pickPlaying(
        [
          { id: 1, visible: 1, distance: 300 },
          { id: 2, visible: 0.6, distance: 40 },
          { id: 3, visible: 0.3, distance: 5 },
        ],
        null,
      );
      expect(picked).toBe(2);
    });

    await it('keeps the one that plays while it still qualifies', async () => {
      const candidates = [
        { id: 1, visible: 0.55, distance: 280 },
        { id: 2, visible: 1, distance: 10 },
      ];
      expect(pickPlaying(candidates, 1)).toBe(1);
      expect(pickPlaying([{ id: 1, visible: 0.2, distance: 400 }, ...candidates.slice(1)], 1)).toBe(2);
    });

    await it('follows the switch, and the system when the person set none', async () => {
      expect(silentVideosOn(true, false)).toBe(true);
      expect(silentVideosOn(false, true)).toBe(false);
      expect(silentVideosOn(undefined, true)).toBe(true);
      expect(silentVideosOn(undefined, false)).toBe(false);
    });

    await it('reads the switch from the config and rejects anything but a boolean', async () => {
      expect(parseConfig('{"backends":{}}').ui.playVideosSilently).toBe(undefined);
      expect(parseConfig('{"backends":{},"ui":{"playVideosSilently":false}}').ui.playVideosSilently).toBe(
        false,
      );
      let message = '';
      try {
        parseConfig('{"backends":{},"ui":{"playVideosSilently":"yes"}}');
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/playVideosSilently/);
    });
  });
};
