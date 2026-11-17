/**
 * The window-wide banner for a daemon wire mismatch: the window or the background service
 * outlived an update. It offers the one restart that fixes it.
 */

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import system from 'system';
import { _ } from '@curlew/protocol';

import type { DaemonWireMismatchError } from '../core/lib/daemon-bus.ts';
import { onWireMismatch } from '../core/lib/wire-mismatch.ts';
import { restartDaemon } from './accounts-daemon.ts';

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

export function createUpdateBanner(app: Gio.Application): Adw.Banner {
  const banner = new Adw.Banner({
    title: _('Curlew was updated. Restart it to continue.'),
    buttonLabel: _('Restart'),
    revealed: false,
  });
  let side: DaemonWireMismatchError['side'] = 'window-older';
  onWireMismatch((error) => {
    side = error.side;
    banner.set_revealed(true);
  });
  banner.connect('button-clicked', () => {
    if (side === 'window-older') return relaunchWindow(app);
    banner.set_revealed(false);
    void restartDaemon().catch(() => banner.set_revealed(true));
  });
  return banner;
}
