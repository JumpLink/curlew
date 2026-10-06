/**
 * Where curlew keeps things.
 *
 * The single promise this file makes: **nothing is ever written inside the repository.** The
 * index holds mail headers AND plain-text bodies, and this repo is public — a stray index file
 * would be a permanent leak, and `.gitignore` is only the second line of defence. Not writing
 * there is the first, and it lives here.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The environment variable `CURLEW_<name>`, falling back to the pre-rename `POSTBOTE_<name>`.
 * The rename fallback is load-bearing: an existing install, service unit or .env keeps working.
 */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`CURLEW_${name}`]?.trim() || env[`POSTBOTE_${name}`]?.trim() || undefined;
}

const announced = new Set<string>();

/** The ONE notice that an old-name directory is still in use — once per directory per process. */
export function announceLegacyDir(legacy: string, current: string): void {
  if (announced.has(legacy)) return;
  announced.add(legacy);
  console.error(`curlew: still using ${legacy} (the old name); move it to ${current} when convenient`);
}

/**
 * `<home>/curlew`, unless only the pre-rename `<home>/postbote` exists. Rename fallback, load-bearing:
 * delivery-only messages live in that directory and are the only copy. Nothing here ever moves it,
 * and a second directory is never created next to it.
 */
export function homeSubdir(home: string, exists: (path: string) => boolean = existsSync): string {
  const current = join(home, 'curlew');
  const legacy = join(home, 'postbote');
  if (exists(current) || !exists(legacy)) return current;
  announceLegacyDir(legacy, current);
  return legacy;
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

/** Where attachments are saved by default. */
export function attachmentsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = envValue(env, 'ATTACHMENTS_DIR');
  if (explicit) return explicit;
  const download = env.XDG_DOWNLOAD_DIR?.trim();
  if (download && download.startsWith('/')) return download;
  return join(dataDir(env), 'attachments');
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
