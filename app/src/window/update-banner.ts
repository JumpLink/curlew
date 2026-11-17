/**
 * The window-wide banner for a daemon wire mismatch: the window or the background service
 * outlived an update. It offers the one restart that fixes it.
 */

import Adw from 'gi://Adw?version=1';
import type Gio from 'gi://Gio?version=2.0';
import { _ } from '@curlew/protocol';

import type { DaemonWireMismatchError } from '../core/lib/daemon-bus.ts';
import { onWireMismatch } from '../core/lib/wire-mismatch.ts';
import { mismatchMessage } from './accounts-model.ts';
import { restartForMismatch } from './mismatch-restart.ts';

export function createUpdateBanner(app: Gio.Application): Adw.Banner {
  const banner = new Adw.Banner({
    title: mismatchMessage('window-older'),
    buttonLabel: _('Restart'),
    revealed: false,
  });
  let side: DaemonWireMismatchError['side'] = 'window-older';
  onWireMismatch((error) => {
    side = error.side;
    banner.set_title(mismatchMessage(side));
    banner.set_revealed(true);
  });
  banner.connect('button-clicked', () => {
    banner.set_revealed(false);
    void restartForMismatch(app, side).then((ok) => banner.set_revealed(!ok));
  });
  return banner;
}
