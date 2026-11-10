/**
 * Which cached parts to drop when the preview cache outgrows its cap. Pure, so the choice is
 * tested without a disk: the least recently written go first, and the part just fetched stays.
 */

/** The cache may hold this much between window starts; a long session of videos would otherwise fill the disk. */
export const PREVIEW_CACHE_MAX_BYTES = 1024 * 1024 * 1024;

export interface CachedPart {
  /** The part's directory name. */
  name: string;
  bytes: number;
  /** When its file was last written, in ms since the epoch. */
  modified: number;
}

/**
 * The names to delete so the rest fits `cap`, oldest first. Names in `keep` are never chosen, even
 * when they alone exceed the cap: a part a person is looking at is worth more than the limit.
 */
export function pickEvictions(
  parts: readonly CachedPart[],
  cap: number,
  keep: readonly string[] = [],
): string[] {
  let total = parts.reduce((sum, p) => sum + p.bytes, 0);
  const drop: string[] = [];
  const candidates = parts.filter((p) => !keep.includes(p.name)).sort((a, b) => a.modified - b.modified);
  for (const part of candidates) {
    if (total <= cap) break;
    drop.push(part.name);
    total -= part.bytes;
  }
  return drop;
}
