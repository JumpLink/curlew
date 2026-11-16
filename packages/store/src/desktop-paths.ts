/**
 * The desktop (GJS / Node) entry to the store's paths: the one place that reads `$XDG_*` and asks
 * for the home directory. `paths.ts` stays platform-free so a shell with its own sandbox
 * directories can call `storePaths()` directly.
 *
 * The functions below keep the names the desktop code has always used; each one is a lookup in
 * `storePaths(defaultStoreDirs(env), env)`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { envValue, homeSubdir, storePaths, type StoreDirs } from './paths.ts';

const absolute = (value: string | undefined): string | undefined => {
  const v = value?.trim();
  return v && v.startsWith('/') ? v : undefined;
};

/** `$XDG_DATA_HOME`, or the spec's default. A relative value is ignored. */
export function xdgDataHome(env: NodeJS.ProcessEnv = process.env): string {
  return absolute(env.XDG_DATA_HOME) ?? join(homedir(), '.local', 'share');
}

/** `$XDG_CONFIG_HOME`, or the spec's default. A relative value is ignored. */
export function xdgConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  return absolute(env.XDG_CONFIG_HOME) ?? join(homedir(), '.config');
}

/** `$XDG_CACHE_HOME`, or the spec's default. A relative value is ignored. */
export function xdgCacheHome(env: NodeJS.ProcessEnv = process.env): string {
  return absolute(env.XDG_CACHE_HOME) ?? join(homedir(), '.cache');
}

/** The desktop base directories. `CURLEW_DATA_DIR` replaces the whole data directory. */
export function defaultStoreDirs(env: NodeJS.ProcessEnv = process.env): StoreDirs {
  return {
    data: envValue(env, 'DATA_DIR') || homeSubdir(xdgDataHome(env)),
    cache: homeSubdir(xdgCacheHome(env)),
    config: homeSubdir(xdgConfigHome(env)),
    download: absolute(env.XDG_DOWNLOAD_DIR),
  };
}

const desktop = (env: NodeJS.ProcessEnv) => storePaths(defaultStoreDirs(env), env);

/** The per-user data directory. Overridable for tests and for a non-standard setup. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return desktop(env).dataDir;
}

/** Path of the SQLite index (`index.db`; an override gains a `.db` suffix). */
export function indexDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return desktop(env).indexDbPath;
}

/**
 * Where backends keep SECRET state — one directory per backend (`secrets/<backend>/`, mode 0700).
 * Apart from the index because it is not rebuildable and must never be served: the index is
 * `derived` in a backup, this is `secret`.
 */
export function secretsDir(env: NodeJS.ProcessEnv = process.env): string {
  return desktop(env).secretsDir;
}

/**
 * The pictures the person picked for their contacts, scaled and saved by the window. They sit in
 * the data directory, not the cache: nothing can fetch them again.
 */
export function contactPicturesDir(env: NodeJS.ProcessEnv = process.env): string {
  return desktop(env).contactPicturesDir;
}

/** Where attachments are saved by default. */
export function attachmentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return desktop(env).attachmentsDir;
}

/**
 * Where the window keeps attachments it fetched for a preview. A cache: it holds message content,
 * so it is private (0700 where created) and the window empties it at start.
 */
export function previewsDir(env: NodeJS.ProcessEnv = process.env): string {
  return desktop(env).previewsDir;
}

/**
 * Where the daemon keeps the profile pictures it fetched for the chat list. A cache, apart from
 * `previewsDir` because the window empties that one at start and these are meant to last.
 */
export function avatarsDir(env: NodeJS.ProcessEnv = process.env): string {
  return desktop(env).avatarsDir;
}

/**
 * Where the daemon copies the files a send handed it as descriptors, one 0700 directory per call,
 * removed when the call ends. The cache home and not `$XDG_RUNTIME_DIR`: that one is tmpfs, and a
 * 60 MB video would sit in RAM.
 */
export function sendStagingDir(env: NodeJS.ProcessEnv = process.env): string {
  return desktop(env).sendStagingDir;
}

/**
 * The config file: which backends are enabled, which terms were accepted, and the per-sender
 * classification overrides. User decisions, not derived data — so it lives under the config
 * home, apart from the rebuildable index.
 */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return desktop(env).configPath;
}
