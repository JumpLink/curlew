/**
 * The file-permission side of {@link SecretStore}, behind a small interface.
 *
 * On a desktop the secret file's protection is POSIX: created 0600 in a 0700 directory. An app
 * sandbox (Android, iOS) is private already, and its key story is different (Keystore, Keychain),
 * so a shell for those platforms plugs its own {@link SecretFiles} in with `useSecretFiles()`
 * instead of the store assuming `openSync(…, 'wx', 0o600)` and `chmodSync`.
 */

import { chmodSync, closeSync, existsSync, openSync, rmSync } from 'node:fs';

import { ensurePrivateDir } from './download.ts';

export interface SecretFiles {
  exists(path: string): boolean;
  /** Make `dir` (and parents) exist and be private to this user. */
  prepareDir(dir: string): void;
  /**
   * Create an empty file, private from its first byte, unless one exists. Never truncates:
   * SQLite takes an empty file as an empty database and an existing one is somebody's session.
   */
  create(path: string): void;
  /** Re-apply the protection on an existing file; a mode that drifted must not stay wrong. */
  restrict(path: string): void;
  /** Delete one file; missing is not an error. */
  remove(path: string): void;
}

/** The desktop implementation: file mode 0600, directory mode 0700. */
export const posixSecretFiles: SecretFiles = {
  exists: (path) => existsSync(path),
  prepareDir(dir) {
    ensurePrivateDir(dir);
  },
  create(path) {
    // Create the file 0600 BEFORE SQLite opens it: SQLite would create it with the umask's mode,
    // and a chmod afterwards leaves a window in which a session key is world-readable. 'wx' is
    // atomic and never truncates.
    if (existsSync(path)) return;
    try {
      closeSync(openSync(path, 'wx', 0o600));
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err;
    }
  },
  restrict(path) {
    if (existsSync(path)) chmodSync(path, 0o600);
  },
  remove(path) {
    rmSync(path, { force: true });
  },
};

let active: SecretFiles = posixSecretFiles;

/** The implementation `SecretStore` uses unless a call passes its own. */
export function secretFiles(): SecretFiles {
  return active;
}

/** Replace the process-wide implementation; call once at start-up, before any store opens. */
export function useSecretFiles(files: SecretFiles): void {
  active = files;
}
