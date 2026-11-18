/**
 * Which window bundle, if any, `index.ts` hands over to for the arguments it got. Pure, so a test
 * pins it on Node and GJS without GTK: the window pulls in GTK, which the CLI bundle never loads.
 *
 * GJS (Linux): only an explicit `window` or `demo` opens the window; a bare `curlew` stays the CLI.
 * Node on macOS and Windows: the package's launcher passes no argument, so no argument opens the
 * window as well, from the `--app node` bundle (`gjsify.ship.bundle`, ADR 0024 § A23 in gjsify).
 * Node on Linux has no window bundle at all.
 */

export interface Handover {
  /** The bundle beside the running one. */
  bundle: './window.gjs.mjs' | './window.node.mjs';
  /** `CURLEW_DEMO=1` before the window starts. */
  demo: boolean;
}

export interface RuntimeInfo {
  gjs: boolean;
  /** Node's naming: `linux`, `darwin`, `win32`. */
  platform: string;
}

/** `args` without the interpreter and the script, as yargs' `hideBin` returns them. */
export function pickHandover(args: readonly string[], runtime: RuntimeInfo): Handover | null {
  const bare = args.length === 0;
  const window = args.length === 1 && args[0] === 'window';
  const demo = args.length === 1 && args[0] === 'demo';
  if (!window && !demo && !bare) return null;
  if (runtime.gjs) return bare ? null : { bundle: './window.gjs.mjs', demo };
  if (runtime.platform === 'darwin' || runtime.platform === 'win32')
    return { bundle: './window.node.mjs', demo };
  return null;
}

/** Does this runtime ship a window of its own, so `curlew window` need not refuse? */
export function hasWindowBundle(runtime: RuntimeInfo): boolean {
  return runtime.gjs || runtime.platform === 'darwin' || runtime.platform === 'win32';
}
