/**
 * A linking QR code as pixels, for a window to show as an image.
 *
 * Always black modules on white with the four-module quiet zone, whatever the theme: a scanner
 * wants dark on light, and inverting it for dark mode would make the code unreadable. Pure and
 * free of GTK so both runtimes test it; the widget only wraps the bytes in a texture.
 */

import qrcode from 'qrcode-generator';

const QUIET = 4;

export interface QrImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, rows top to bottom with no padding. */
  rgba: Uint8Array;
}

/** The module grid including the quiet zone: `true` is a dark module. */
export function qrGrid(data: string): boolean[][] {
  const code = qrcode(0, 'L');
  code.addData(data);
  code.make();
  const size = code.getModuleCount();
  const total = size + 2 * QUIET;
  const grid: boolean[][] = [];
  for (let row = 0; row < total; row++) {
    const cells: boolean[] = [];
    for (let col = 0; col < total; col++) {
      const r = row - QUIET;
      const c = col - QUIET;
      cells.push(r >= 0 && c >= 0 && r < size && c < size && code.isDark(r, c));
    }
    grid.push(cells);
  }
  return grid;
}

/** Each module becomes a `scale` × `scale` square, so the edges stay sharp when shown unscaled. */
export function qrImage(data: string, scale: number): QrImage {
  const grid = qrGrid(data);
  const modules = grid.length;
  const width = modules * scale;
  const rgba = new Uint8Array(width * width * 4);
  for (let y = 0; y < width; y++) {
    const cells = grid[Math.floor(y / scale)];
    for (let x = 0; x < width; x++) {
      const value = cells[Math.floor(x / scale)] ? 0 : 255;
      const at = (y * width + x) * 4;
      rgba[at] = value;
      rgba[at + 1] = value;
      rgba[at + 2] = value;
      rgba[at + 3] = 255;
    }
  }
  return { width, height: width, rgba };
}

/** The largest whole-pixel scale at which the code fits `maxPixels` square, at least 2. */
export function qrScaleFor(data: string, maxPixels: number): number {
  return Math.max(2, Math.floor(maxPixels / qrGrid(data).length));
}
