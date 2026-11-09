import { describe, expect, it } from '@gjsify/unit';

import { GRID_GAP, gridLayout, MAX_GRID_CELLS } from '../../../src/window/media-grid-model.ts';

const landscape = { width: 1600, height: 900 };
const portrait = { width: 900, height: 1600 };

export default async () => {
  await describe('gridLayout', async () => {
    await it('is no grid for none or one part', async () => {
      expect(gridLayout([], 280).cells.length).toBe(0);
      expect(gridLayout([landscape], 280).cells.length).toBe(0);
    });

    await it('puts two parts side by side across the whole width', async () => {
      const { cells, width } = gridLayout([landscape, landscape], 280);
      expect(width).toBe(280);
      expect(cells.length).toBe(2);
      expect(cells[0]!.y).toBe(cells[1]!.y);
      expect(cells[0]!.x).toBe(0);
      expect(cells[1]!.x + cells[1]!.width).toBe(280);
      expect(cells[1]!.x).toBe(cells[0]!.width + GRID_GAP);
    });

    await it('gives three parts one wide cell above two', async () => {
      const { cells, height } = gridLayout([landscape, landscape, landscape], 280);
      expect(cells.length).toBe(3);
      expect(cells[0]!.width).toBe(280);
      expect(cells[1]!.y).toBe(cells[0]!.height + GRID_GAP);
      expect(cells[1]!.y).toBe(cells[2]!.y);
      expect(height).toBe(cells[1]!.y + cells[1]!.height);
    });

    await it('ends every row at the grid edge for any count', async () => {
      for (let count = 2; count <= MAX_GRID_CELLS; count++) {
        const parts = Array.from({ length: count }, (_, i) => (i % 2 ? portrait : landscape));
        const { cells } = gridLayout(parts, 320);
        expect(cells.length).toBe(count);
        for (const cell of cells) expect(cell.x + cell.width <= 320).toBe(true);
        const rows = new Set(cells.map((c) => c.y));
        for (const y of rows) {
          const last = cells.filter((c) => c.y === y).reduce((a, b) => (a.x > b.x ? a : b));
          expect(last.x + last.width).toBe(320);
        }
      }
    });

    await it('gives a portrait part less width than a landscape one beside it', async () => {
      const { cells } = gridLayout([portrait, landscape], 300);
      expect(cells[0]!.width < cells[1]!.width).toBe(true);
    });

    await it('keeps rows within a readable height and treats unsized parts as 4:3', async () => {
      const wide = gridLayout(
        [
          { width: 4000, height: 100 },
          { width: 4000, height: 100 },
        ],
        280,
      );
      expect(wide.cells[0]!.height >= 90).toBe(true);
      const tall = gridLayout(
        [
          { width: 100, height: 4000 },
          { width: 100, height: 4000 },
        ],
        280,
      );
      expect(tall.cells[0]!.height <= 240).toBe(true);
      const unsized = gridLayout([{}, { width: null, height: null }], 280);
      expect(unsized.cells[0]!.width).toBe(unsized.cells[1]!.width);
    });

    await it('shows at most nine cells', async () => {
      const parts = Array.from({ length: 14 }, () => landscape);
      expect(gridLayout(parts, 320).cells.length).toBe(MAX_GRID_CELLS);
    });
  });
};
