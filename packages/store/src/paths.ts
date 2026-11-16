/**
 * Where curlew keeps things.
 *
 * The single promise this file makes: **nothing is ever written inside the repository.** The
 * index holds mail headers AND plain-text bodies, and this repo is public — a stray index file
 * would be a permanent leak, and `.gitignore` is only the second line of defence. Not writing
 * there is the first, and it lives here.
 *
 * This file is platform-free: it never reads `$XDG_*` and never asks for a home directory. The
 * caller hands in the base directories ({@link StoreDirs}) — the desktop entry points get them
 * from `defaultStoreDirs()` in `desktop-paths.ts`, the one place that knows about XDG; an
 * Android or iOS shell passes its app sandbox directories.
 */

import { join } from 'node:path';

/**
 * The base directories everything else hangs off. All absolute.
 *
 * - `data`: irreplaceable local state (index, secrets, contact pictures).
 * - `cache`: rebuildable material (previews, avatars, send staging).
 * - `config`: user decisions (`config.json`).
 * - `download`: where attachments land by default; omitted, they go under `data`.
 */
export interface StoreDirs {
  data: string;
  cache: string;
  config: string;
  download?: string;
}

/** Every location the store derives from {@link StoreDirs}. */
export interface StorePaths {
  dataDir: string;
  indexDbPath: string;
  secretsDir: string;
  contactPicturesDir: string;
  attachmentsDir: string;
  previewsDir: string;
  avatarsDir: string;
  thumbsDir: string;
  sendStagingDir: string;
  configPath: string;
}

/** The environment variable `CURLEW_<name>`, trimmed; undefined when unset or blank. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`CURLEW_${name}`]?.trim() || undefined;
}

/** `<home>/curlew`. */
export function homeSubdir(home: string): string {
  return join(home, 'curlew');
}

/**
 * Derive every path from the base directories.
 *
 * `env` only carries the `CURLEW_*` per-location overrides and defaults to none, so a caller
 * that wants no ambient influence (an app on a phone, a test) passes nothing.
 *
 * `CURLEW_DB_PATH` keeps a `.db` suffix: gjsify's `node:sqlite` no longer appends one (it opens
 * the exact path, on libsqlite3 through a Vala bridge), but the account files in `secretsDir`
 * are found by that suffix and existing indexes sit at `index.db`, so the name stays one rule.
 */
export function storePaths(dirs: StoreDirs, env: NodeJS.ProcessEnv = {}): StorePaths {
  const pick = (name: string, fallback: string): string => envValue(env, name) || fallback;
  const data = dirs.data;
  const explicitDb = envValue(env, 'DB_PATH');
  return {
    dataDir: data,
    indexDbPath: explicitDb
      ? explicitDb.endsWith('.db')
        ? explicitDb
        : `${explicitDb}.db`
      : join(data, 'index.db'),
    secretsDir: pick('SECRETS_DIR', join(data, 'secrets')),
    contactPicturesDir: pick('CONTACT_PICTURES_DIR', join(data, 'contact-pictures')),
    attachmentsDir: pick('ATTACHMENTS_DIR', dirs.download || join(data, 'attachments')),
    previewsDir: pick('PREVIEWS_DIR', join(dirs.cache, 'previews')),
    avatarsDir: pick('AVATARS_DIR', join(dirs.cache, 'avatars')),
    thumbsDir: pick('THUMBS_DIR', join(dirs.cache, 'thumbs')),
    sendStagingDir: pick('STAGING_DIR', join(dirs.cache, 'outgoing')),
    configPath: pick('CONFIG', join(dirs.config, 'config.json')),
  };
}
