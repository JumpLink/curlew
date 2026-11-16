/**
 * Which cached parts to drop when the preview cache outgrows its cap. Pure, so the choice is
 * tested without a disk: the least recently written go first, and the part just fetched stays.
 */

import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageRef } from '@curlew/protocol';

import { previewKey } from './attachment-model.ts';
import type { AttachmentInfo } from './conversation-model.ts';

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

/** The directory under `root` that holds one part's bytes. */
export function partDir(source: { ref: MessageRef; info: AttachmentInfo }, root: string): string {
  const key = previewKey(source.ref, source.info.section ?? '', source.info.index);
  // Not GLib's checksum: it reads a C string and stops at the NUL that separates the key's fields.
  return join(root, createHash('sha256').update(key).digest('hex'));
}

/** The finished file in a part directory, skipping a half-written `.part`; null when there is none. */
export function cachedFile(dir: string): string | null {
  try {
    return readdirSync(dir).find((name) => !name.endsWith('.part')) ?? null;
  } catch {
    return null;
  }
}

/** The path of the part's bytes when they are already cached under `root`, else null. Never fetches. */
export function cachedPath(source: { ref: MessageRef; info: AttachmentInfo }, root: string): string | null {
  const dir = partDir(source, root);
  const hit = cachedFile(dir);
  return hit ? join(dir, hit) : null;
}
