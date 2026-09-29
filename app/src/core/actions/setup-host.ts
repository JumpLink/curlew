/**
 * What `postbote setup` is allowed to touch on the machine.
 *
 * A port, not a pile of `execSync` calls: the setup steps are pure logic over this, so the whole
 * run can be driven by a fake on Node as well as by the real thing on GJS. A future Adwaita
 * frontend drives the same steps and can supply the same host.
 *
 * `run()` has ONE security-relevant option. `capture: false` (the default) leaves the child's
 * output attached to the terminal — that is what every linking call needs, because a linking
 * call's output is the QR. A step must never set `capture: true` around a linking call: the
 * linking actions are called IN-PROCESS with the shared prompter and never go through `run()` at
 * all. The single legitimate capture is `systemd-analyze --user verify` on a unit file.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export interface RunOptions {
  /**
   * Take the child's output instead of leaving it attached. ONLY for output that is
   * configuration (a unit file check). Never around a linking call.
   */
  capture?: boolean;
  /** Seconds before the child is killed. */
  timeout?: number;
}

export interface RunResult {
  code: number;
  /** Filled only for a captured run; empty otherwise, by construction. */
  output: string;
}

export interface CommandRunner {
  /** Absolute path of the bundle this process is running from, or null when it cannot be
   * determined. A published install and a checkout both have one. */
  bundlePath(): string | null;
  /** Absolute path of a command on PATH, or null. */
  which(command: string): string | null;
  run(argv: readonly string[], options?: RunOptions): RunResult;
  readFile(path: string): string | null;
  writeFile(path: string, text: string): void;
  mkdirp(path: string): void;
  exists(path: string): boolean;
  home(): string;
  env(name: string): string | undefined;
}

/**
 * The bundle's OWN path, read from the banner gjsify emits for ESM output
 * (`globalThis.__gjsifyBundleUrl ??= import.meta.url`, gjsify's module-resolve shim).
 *
 * This is what the systemd unit's `ExecStart` needs — a built postbote cannot read the unit off
 * disk, and the addon path is baked in at build time, so the unit has to name the file this very
 * process came out of rather than a guess. Read defensively: the banner is absent under a bundler
 * that predates it or on a runtime that does not take the ESM path, and a missing banner is a
 * clear error at the unit stage, never a silently wrong path.
 */
export function currentBundlePath(): string | null {
  const url = (globalThis as { __gjsifyBundleUrl?: unknown }).__gjsifyBundleUrl;
  if (typeof url !== 'string' || !url.startsWith('file:')) return null;
  try {
    return fileUrlToPath(url);
  } catch {
    return null;
  }
}

function fileUrlToPath(url: string): string {
  // Imported lazily-by-hand rather than via `node:url` so the failure mode above is one branch.
  const decoded = decodeURIComponent(url.replace(/^file:\/\//, ''));
  return decoded;
}

/** The real machine. Every method here is the real filesystem or a real child process. */
export function nodeHost(env: NodeJS.ProcessEnv = process.env): CommandRunner {
  return {
    bundlePath: currentBundlePath,
    which(command) {
      const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
      for (const dir of dirs) {
        const candidate = join(dir, command);
        try {
          if (existsSync(candidate)) return candidate;
        } catch {
          // An unreadable PATH entry is not a reason to stop looking in the next one.
        }
      }
      return null;
    },
    run(argv, options = {}) {
      const [command, ...args] = argv;
      const result = spawnSync(command ?? '', args ?? [], {
        encoding: 'utf8',
        // Not captured: a linking call's output IS the QR, and it has to stay on this terminal.
        // Inherit stdio and return an empty `output` so there is no path by which a child's
        // output can be read back into the run.
        stdio: options.capture === true ? ['inherit', 'pipe', 'pipe'] : 'inherit',
        timeout: options.timeout === undefined ? undefined : options.timeout * 1000,
      });
      const output =
        options.capture === true ? `${result.stdout ?? ''}${result.stderr ?? ''}` : '';
      return { code: result.status ?? (result.error ? 127 : 1), output };
    },
    readFile(path) {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    writeFile(path, text) {
      writeFileSync(path, text, { mode: 0o644 });
    },
    mkdirp(path) {
      mkdirSync(path, { recursive: true });
    },
    exists(path) {
      try {
        return existsSync(path);
      } catch {
        return false;
      }
    },
    home() {
      return env.HOME ?? homedir();
    },
    env(name) {
      return env[name];
    },
  };
}

/** `$XDG_CONFIG_HOME/systemd/user`, XDG-correct — never a hardcoded `~/.config`. */
export function systemdUserUnitDir(host: CommandRunner): string {
  const xdg = host.env('XDG_CONFIG_HOME');
  const base = xdg !== undefined && xdg !== '' ? xdg : join(host.home(), '.config');
  return join(base, 'systemd', 'user');
}

/** `$XDG_DATA_HOME/postbote`'s config sibling — the same rule as `@postbote/store`'s paths. */
export function xdgConfigHome(host: CommandRunner): string {
  const xdg = host.env('XDG_CONFIG_HOME');
  return xdg !== undefined && xdg !== '' ? xdg : join(host.home(), '.config');
}

/** Create the parent directory of a file, then write it. */
export function writeFileEnsured(host: CommandRunner, path: string, text: string): void {
  host.mkdirp(dirname(path));
  host.writeFile(path, text);
}
