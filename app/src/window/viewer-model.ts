/**
 * Moving through the pictures and videos of one message in the viewer. Pure, so the stepping and
 * the swipe decision are tested without a window.
 */

/** The index after moving `delta` places, or null at either end: the album does not wrap. */
export function albumStep(index: number, count: number, delta: number): number | null {
  const next = index + delta;
  return next < 0 || next >= count ? null : next;
}

/** 1-based position for display, e.g. `2 / 4`; empty for a single item. */
export function albumPosition(index: number, count: number): string {
  return count > 1 ? `${index + 1} / ${count}` : '';
}

/** Fast enough to count as a swipe, in pixels per second. */
export const SWIPE_MIN_VELOCITY = 400;

/**
 * Which way a swipe moves through the album: -1 to the previous item (finger moves right), +1 to
 * the next (finger moves left), 0 for a slow or mostly vertical gesture.
 */
export function swipeStep(vx: number, vy: number): -1 | 0 | 1 {
  if (Math.abs(vx) < SWIPE_MIN_VELOCITY || Math.abs(vx) < Math.abs(vy) * 1.5) return 0;
  return vx < 0 ? 1 : -1;
}
