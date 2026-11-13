import { describe, expect, it } from '@gjsify/unit';

import { isStall, stallProbeEnabled, stallThreshold } from '../../../src/window/stall-probe-model.ts';

export default async () => {
  describe('the main-loop stall probe', () => {
    it('is off unless CURLEW_DEBUG_STALL is 1', () => {
      expect(stallProbeEnabled({})).toBe(false);
      expect(stallProbeEnabled({ CURLEW_DEBUG_STALL: '0' })).toBe(false);
      expect(stallProbeEnabled({ CURLEW_DEBUG_STALL: '1' })).toBe(true);
    });
    it('reads the threshold, falling back to 50 ms', () => {
      expect(stallThreshold({})).toBe(50);
      expect(stallThreshold({ CURLEW_DEBUG_STALL_MS: 'x' })).toBe(50);
      expect(stallThreshold({ CURLEW_DEBUG_STALL_MS: '-3' })).toBe(50);
      expect(stallThreshold({ CURLEW_DEBUG_STALL_MS: '120' })).toBe(120);
    });
    it('counts only ticks later than the threshold', () => {
      expect(isStall(50, 50)).toBe(false);
      expect(isStall(51, 50)).toBe(true);
    });
  });
};
