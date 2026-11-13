/**
 * Where curlew keeps things.
 *
 * The single promise this file makes: **nothing is ever written inside the repository.** The
 * index holds mail headers AND plain-text bodies, and this repo is public — a stray index file
 * would be a permanent leak, and `.gitignore` is only the second line of defence. Not writing
 * there is the first, and it lives here.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** The environment variable `CURLEW_<name>`, trimmed; undefined when unset or blank. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`CURLEW_${name}`]?.trim() || undefined;
}

/** `<home>/curlew`. */
export function homeSubdir(home: string): string {
  return join(home, 'curlew');
}

/** `$XDG_DATA_HOME`, or the spec's default. */
export function xdgDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.XDG_DATA_HOME?.trim();
  return explicit && explicit.startsWith('/') ? explicit : join(homedir(), '.local', 'share');
}

/** The per-user data directory. Overridable for tests and for a non-standard setup. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = envValue(env, 'DATA_DIR');
  return explicit || homeSubdir(xdgDataHome(env));
}

/**
 * Path of the SQLite index.
 *
 * The `.db` suffix is REQUIRED, not conventional: gjsify's `node:sqlite` is a libgda wrapper,
 * and libgda appends `.db` to whatever name it is given. A file called `index.sqlite` therefore
 * lands on disk as `index.sqlite.db`, and the next open creates `index.sqlite.db.db`.
 */
export function indexDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = envValue(env, 'DB_PATH');
  if (explicit) return explicit.endsWith('.db') ? explicit : `${explicit}.db`;
  return join(dataDir(env), 'index.db');
}

/**
 * Where backends keep SECRET state — chat sessions, auth keys, crypto stores — one directory per
 * backend (`secrets/<backend>/`, mode 0700). Apart from the index because it is not rebuildable
 * and must never be served: the index is `derived` in a backup, this is `secret`.
 */
export function secretsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = envValue(env, 'SECRETS_DIR');
  return explicit || join(dataDir(env), 'secrets');
}

/**
 * The pictures the person picked for their contacts, scaled and saved by the window. They sit in
 * the data directory, not the cache: nothing can fetch them again.
 */
export function contactPicturesDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = envValue(env, 'CONTACT_PICTURES_DIR');
  return explicit || join(dataDir(env), 'contact-pictures');
}

/** Where attachments are saved by default. */
export function attachmentsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = envValue(env, 'ATTACHMENTS_DIR');
  if (explicit) return explicit;
  const download = env.XDG_DOWNLOAD_DIR?.trim();
  if (download && download.startsWith('/')) return download;
  return join(dataDir(env), 'attachments');
}

/**
 * Where the window keeps attachments it fetched for a preview. A cache: it holds message content,
 * so it is private (0700 where created) and the window empties it at start.
 */
export function previewsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = envValue(env, 'PREVIEWS_DIR');
  if (explicit) return explicit;
  const cache = env.XDG_CACHE_HOME?.trim();
  return join(cache && cache.startsWith('/') ? cache : join(homedir(), '.cache'), 'curlew', 'previews');
}

/**
 * Where the daemon keeps the profile pictures it fetched for the chat list. A cache, apart from
 * `previewsDir` because the window empties that one at start and these are meant to last.
 */
export function avatarsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = envValue(env, 'AVATARS_DIR');
  if (explicit) return explicit;
  const cache = env.XDG_CACHE_HOME?.trim();
  return join(cache && cache.startsWith('/') ? cache : join(homedir(), '.cache'), 'curlew', 'avatars');
}

/**
 * Where the daemon copies the files a send handed it as descriptors, one 0700 directory per call,
 * removed when the call ends. The cache home and not `$XDG_RUNTIME_DIR`: that one is tmpfs, and a
 * 60 MB video would sit in RAM.
 */
export function sendStagingDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = envValue(env, 'STAGING_DIR');
  if (explicit) return explicit;
  const cache = env.XDG_CACHE_HOME?.trim();
  return join(cache && cache.startsWith('/') ? cache : join(homedir(), '.cache'), 'curlew', 'outgoing');
}

/** `$XDG_CONFIG_HOME`, or the spec's default. A relative value is ignored, as for the data home. */
export function xdgConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.XDG_CONFIG_HOME?.trim();
  return explicit && explicit.startsWith('/') ? explicit : join(homedir(), '.config');
}

/**
 * The config file: which backends are enabled, which terms were accepted, and the per-sender
 * classification overrides. User decisions, not derived data — so it lives under the config
 * home, apart from the rebuildable index.
 */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = envValue(env, 'CONFIG');
  return explicit || join(homeSubdir(xdgConfigHome(env)), 'config.json');
}
