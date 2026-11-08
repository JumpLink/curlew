import { describe, expect, it } from '@gjsify/unit';

import {
  mergePicked,
  pastedImageName,
  pickedNames,
  type PickedFile,
} from '../../../src/window/composer-files-model.ts';

const file = (path: string): PickedFile => ({
  path,
  name: path.split('/').pop()!,
  size: 1,
  temporary: false,
});

export default async () => {
  await describe('composer files', async () => {
    await it('adds a path only once', async () => {
      const first = mergePicked([], [file('/a/one.txt'), file('/a/one.txt')]);
      expect(first.files.length).toBe(1);
      const again = mergePicked(first.files, [file('/a/one.txt'), file('/a/two.txt')]);
      expect(again.files.map((f) => f.name).join(',')).toBe('one.txt,two.txt');
      expect(again.skipped).toBe(0);
    });

    await it('stops at the limit and counts what it left out', async () => {
      const got = mergePicked([file('/a/1')], [file('/a/2'), file('/a/3'), file('/a/4')], 2);
      expect(got.files.length).toBe(2);
      expect(got.skipped).toBe(2);
    });

    await it('names a pasted picture by its time', async () => {
      expect(pastedImageName(new Date(2026, 10, 8, 9, 5, 3))).toBe('pasted-image-2026-11-08-090503.png');
    });

    await it('lists names for a message without text', async () => {
      expect(pickedNames([file('/a/x.png'), file('/b/y.pdf')])).toBe('x.png, y.pdf');
    });
  });
};
