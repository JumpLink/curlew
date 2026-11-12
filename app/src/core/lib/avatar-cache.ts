/**
 * The on-disk cache of profile pictures, shared by the daemon that fills it and the window that
 * reads it without asking: both compute the same path from the same three facts.
 *
 * A picture is `<root>/<account>/<peer>.img`; a peer that has none is a `<peer>.none` marker, so
 * the daemon is not asked again for every row on every start. Both go stale and are fetched
 * again, but a stale picture is still shown while that happens.
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';

/** A picture is looked up again after this long. */
export const AVATAR_TTL_MS = 7 * 24 * 3_600_000;
/** "No picture" is looked up again sooner: someone may have set one. */
export const AVATAR_NONE_TTL_MS = 24 * 3_600_000;

export type AvatarState =
  | { kind: 'hit'; path: string; stale: boolean }
  | { kind: 'none'; stale: boolean }
  | { kind: 'unknown' };

const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** The directory for one account's pictures: the backend is part of the key, ids repeat across them. */
export function avatarAccountDir(root: string, backend: string, account: string): string {
  return join(root, hash(`${backend}\u0000${account}`));
}

/** The two files one peer can have. */
export function avatarFiles(
  root: string,
  backend: string,
  account: string,
  peer: string,
): { image: string; none: string } {
  const base = join(avatarAccountDir(root, backend, account), hash(peer));
  return { image: `${base}.img`, none: `${base}.none` };
}

function ageOf(path: string, now: number): number | null {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** What the cache knows about one peer. A picture wins over a marker. */
export function avatarState(
  root: string,
  backend: string,
  account: string,
  peer: string,
  now = Date.now(),
): AvatarState {
  const files = avatarFiles(root, backend, account, peer);
  const imageAge = ageOf(files.image, now);
  if (imageAge !== null) return { kind: 'hit', path: files.image, stale: imageAge > AVATAR_TTL_MS };
  const noneAge = ageOf(files.none, now);
  if (noneAge !== null) return { kind: 'none', stale: noneAge > AVATAR_NONE_TTL_MS };
  return { kind: 'unknown' };
}
