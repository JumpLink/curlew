import { describe, expect, it } from '@gjsify/unit';

import { qrGrid, qrImage, qrScaleFor } from '../../../src/window/qr-image.ts';

export default async () => {
  await describe('the QR image', async () => {
    await it('has a light quiet zone of four modules on every side', async () => {
      const grid = qrGrid('https://example.org/link');
      const last = grid.length - 1;
      for (let i = 0; i <= last; i++) {
        for (let q = 0; q < 4; q++) {
          expect(grid[q][i]).toBe(false);
          expect(grid[last - q][i]).toBe(false);
          expect(grid[i][q]).toBe(false);
          expect(grid[i][last - q]).toBe(false);
        }
      }
    });

    await it('is square with every module scaled to whole pixels', async () => {
      const grid = qrGrid('example');
      const image = qrImage('example', 3);
      expect(image.width).toBe(grid.length * 3);
      expect(image.height).toBe(image.width);
      expect(image.rgba.length).toBe(image.width * image.height * 4);
    });

    await it('draws dark modules black and the rest white, fully opaque', async () => {
      const grid = qrGrid('example');
      const image = qrImage('example', 2);
      // The finder pattern's corner is dark, just inside the quiet zone.
      const at = (4 * 2 * image.width + 4 * 2) * 4;
      expect(grid[4][4]).toBe(true);
      expect(image.rgba[at]).toBe(0);
      expect(image.rgba[at + 3]).toBe(255);
      expect(image.rgba[0]).toBe(255);
      expect(image.rgba[3]).toBe(255);
    });

    await it('picks the largest whole scale that fits, and never less than 2', async () => {
      const modules = qrGrid('example').length;
      expect(qrScaleFor('example', modules * 5 + 3)).toBe(5);
      expect(qrScaleFor('example', 1)).toBe(2);
    });
  });
};
