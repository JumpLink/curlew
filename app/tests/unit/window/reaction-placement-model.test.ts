import { describe, expect, it } from '@gjsify/unit';

import { reactionPlacement } from '../../../src/window/reaction-placement-model.ts';

export default async () => {
  describe('reactionPlacement', () => {
    it('puts chips under a bubble that is only media', () => {
      expect(reactionPlacement({ bodyText: '', hasAttachments: true })).toBe('below');
      expect(reactionPlacement({ bodyText: '  \n', hasAttachments: true })).toBe('below');
      expect(reactionPlacement({ hasAttachments: true })).toBe('below');
    });
    it('keeps chips inside a bubble with text', () => {
      expect(reactionPlacement({ bodyText: 'Hi', hasAttachments: true })).toBe('inside');
      expect(reactionPlacement({ bodyText: 'Hi', hasAttachments: false })).toBe('inside');
      expect(reactionPlacement({ bodyText: '', hasAttachments: false })).toBe('inside');
    });
    it('keeps chips inside a notice', () => {
      expect(reactionPlacement({ bodyText: '', notice: true, hasAttachments: true })).toBe('inside');
    });
  });
};
