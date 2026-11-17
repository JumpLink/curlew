/** The restart for a daemon wire mismatch, shared by the window banner and the Accounts dialog. */

import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import system from 'system';

import { restartDaemon } from './accounts-daemon.ts';
import { restartAfterMismatch, type MismatchSide } from './mismatch-restart-model.ts';

/** Start this window again after a moment, then quit; a unique application would hand a new one to this process. */
function relaunchWindow(app: Gio.Application): void {
  // The bundle is a module, not an executable: prefer the launcher the desktop file runs (it sets
  // the environment a build needs, e.g. LD_PRELOAD on a phone), else gjs on this very bundle.
  const launcher = GLib.find_program_in_path('curlew');
  const gjs = GLib.find_program_in_path('gjs');
  const bundle = system.programPath;
  const argv = launcher ? [launcher, 'window'] : gjs && bundle ? [gjs, '-m', bundle, 'window'] : null;
  if (argv === null) return;
  try {
    Gio.Subprocess.new(['sh', '-c', 'sleep 1; exec "$@"', 'curlew', ...argv], Gio.SubprocessFlags.NONE);
  } catch {
    return;
  }
  app.quit();
}

export function restartForMismatch(app: Gio.Application, side: MismatchSide): Promise<boolean> {
  return restartAfterMismatch(side, { relaunchWindow: () => relaunchWindow(app), restartDaemon });
}
