/**
 * Which silent video preview plays (docs/design/media-grid.md, piece 3). Pure, so the choice is
 * tested without a window: at most one plays, and only one that is mostly on screen.
 */

export interface VideoCandidate {
  id: number;
  /** How much of the preview is inside the viewport, 0 to 1. */
  visible: number;
  /** Distance of the preview's centre from the viewport's centre, in pixels. */
  distance: number;
}

/** A preview plays only while at least this much of it is on screen. */
export const MIN_VISIBLE = 0.5;

/**
 * The preview that should play now, or null. The one already playing keeps playing while it still
 * qualifies, so a scroll does not hand the slot back and forth; otherwise the one nearest the
 * middle of the viewport wins.
 */
export function pickPlaying(candidates: readonly VideoCandidate[], current: number | null): number | null {
  const fit = candidates.filter((c) => c.visible >= MIN_VISIBLE);
  if (current !== null && fit.some((c) => c.id === current)) return current;
  let best: VideoCandidate | null = null;
  for (const c of fit) if (best === null || c.distance < best.distance) best = c;
  return best?.id ?? null;
}

/** The person's switch if they set one, else on unless the system asks for fewer animations. */
export function silentVideosOn(setting: boolean | undefined, systemAnimations: boolean): boolean {
  return setting ?? systemAnimations;
}
