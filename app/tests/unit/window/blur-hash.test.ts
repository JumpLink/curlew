import { describe, expect, it } from '@gjsify/unit';

import { decodeBlurHash, isValidBlurHash } from '../../../src/window/blur-hash.ts';

const HASH = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';

export default async () => {
  await describe('decodeBlurHash', async () => {
    await it('decodes to opaque RGBA of the asked size', async () => {
      const px = decodeBlurHash(HASH, 8, 6);
      expect(px?.length).toBe(8 * 6 * 4);
      expect(px?.[3]).toBe(255);
    });

    await it('rejects malformed hashes and sizes', async () => {
      expect(isValidBlurHash(HASH)).toBe(true);
      expect(isValidBlurHash('short')).toBe(false);
      expect(isValidBlurHash(HASH + 'x')).toBe(false);
      expect(decodeBlurHash('not a hash!', 4, 4)).toBe(null);
      expect(decodeBlurHash(HASH, 0, 4)).toBe(null);
    });
  });
};
