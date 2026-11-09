/**
 * The grid a message's pictures and videos form (docs/design/media-grid.md): which cell goes in
 * which row, and the size of every cell. Pure, so the layout is tested without a window.
 */

export interface GridPart {
  /** The part's own size when the index knows it; a part without one counts as 4:3. */
  width?: number | null;
  height?: number | null;
}

export interface GridCell {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GridLayout {
  cells: GridCell[];
  width: number;
  height: number;
}

/** More parts than this: the first nine form the grid, the rest list as tiles below it. */
export const MAX_GRID_CELLS = 9;

export const GRID_GAP = 2;
const MIN_ROW_HEIGHT = 90;
const MAX_ROW_HEIGHT = 240;
const UNKNOWN_RATIO = 4 / 3;

/** How many cells each row holds, top to bottom, for 2 to `MAX_GRID_CELLS` parts. */
const ROWS: Record<number, readonly number[]> = {
  2: [2],
  3: [1, 2],
  4: [2, 2],
  5: [2, 3],
  6: [3, 3],
  7: [1, 3, 3],
  8: [2, 3, 3],
  9: [3, 3, 3],
};

function ratio(part: GridPart): number {
  const { width, height } = part;
  return width && height && width > 0 && height > 0 ? width / height : UNKNOWN_RATIO;
}

/**
 * Cells for `parts` inside `maxWidth`. Every row is as wide as the grid and its cells share that
 * width by their ratios, so a portrait part is narrower than a landscape one next to it; the row
 * height follows from that and is kept within a range, a cell cropping what does not fit. One part
 * or none is not a grid and gets no cells; the caller shows a single picture its own way.
 */
export function gridLayout(parts: readonly GridPart[], maxWidth: number): GridLayout {
  const count = Math.min(parts.length, MAX_GRID_CELLS);
  const rows = ROWS[count];
  if (!rows) return { cells: [], width: 0, height: 0 };

  const cells: GridCell[] = [];
  let next = 0;
  let y = 0;
  for (const inRow of rows) {
    const members = parts.slice(next, next + inRow).map(ratio);
    next += inRow;
    const usable = maxWidth - GRID_GAP * (inRow - 1);
    const total = members.reduce((sum, r) => sum + r, 0);
    const height = Math.round(Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, usable / total)));
    let x = 0;
    members.forEach((r, i) => {
      // The last cell takes what rounding left, so a row always ends at the grid's edge.
      const width = i === inRow - 1 ? maxWidth - x : Math.round((usable * r) / total);
      cells.push({ x, y, width, height });
      x += width + GRID_GAP;
    });
    y += height + GRID_GAP;
  }
  return { cells, width: maxWidth, height: y - GRID_GAP };
}
