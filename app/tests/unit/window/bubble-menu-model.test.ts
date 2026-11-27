import { describe, expect, it } from '@gjsify/unit';

import { bubbleMenuEntries, selectableFor } from '../../../src/window/bubble-menu-model.ts';

export default async () => {
  describe('bubbleMenuEntries', () => {
    it('orders Reply, Edit, Copy, Delete', () => {
      const all = { reply: true, edit: true, delete: true, copy: true, transcribe: true };
      expect(
        bubbleMenuEntries(all)
          .map((e) => e.id)
          .join(','),
      ).toBe('reply,edit,copy,transcribe,delete');
    });
    it('drops what does not apply', () => {
      const some = { reply: false, edit: false, delete: false, copy: true, transcribe: false };
      expect(
        bubbleMenuEntries(some)
          .map((e) => e.id)
          .join(','),
      ).toBe('copy');
    });
    it('marks only Delete destructive', () => {
      const all = { reply: true, edit: true, delete: true, copy: true, transcribe: true };
      expect(
        bubbleMenuEntries(all)
          .filter((e) => e.destructive)
          .map((e) => e.id)
          .join(','),
      ).toBe('delete');
    });
  });
  describe('selectableFor', () => {
    it('is off for touch and on for a pointer', () => {
      expect(selectableFor(true)).toBe(false);
      expect(selectableFor(false)).toBe(true);
    });
  });
};
