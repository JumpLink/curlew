/**
 * The Background portal as the `Autostart` driver inside a sandbox (ADR 0011), through libportal
 * (gjsify ADR 0101: app code does not call `org.freedesktop.portal.*` itself).
 *
 * libportal is loaded lazily and inside a try: a missing typelib reads `unavailable`, it never stops
 * the process. The portal has no query, so `status()` is `unknown`; the answer to the last request is
 * not recorded here because a person can revoke it in the system settings behind our back.
 */

import type Gtk from 'gi://Gtk?version=4.0';
import type XdpModule from 'gi://Xdp?version=1.0';
import type XdpGtk4Module from 'gi://XdpGtk4?version=1.0';
import { _ } from '@curlew/protocol';
import { systemdAutostart, type Autostart, type AutostartResult } from '../actions/autostart.ts';
import type { CommandRunner } from '../actions/setup-host.ts';
import { backgroundRequest, backgroundResult, unavailableResult } from './autostart-portal-model.ts';
import { inSandbox } from './sandbox.ts';

type Xdp = typeof XdpModule;
type XdpGtk4 = typeof XdpGtk4Module;
// libportal's typings carry their own copy of Gio, so its result type is taken from the call itself.
type PortalResult = Parameters<InstanceType<Xdp['Portal']>['request_background_finish']>[0];

export interface PortalAutostartOptions {
  /** What the portal starts at login: `curlew daemon`, as the sandbox sees it. */
  commandline: string[];
  /** Shown by the portal's dialog. */
  reason: string;
  /** The window the dialog belongs to, when there is one; without it the dialog has no parent. */
  parent?: () => Gtk.Window | null;
}

export function portalAutostart(options: PortalAutostartOptions): Autostart {
  let loaded: Promise<{ Xdp: Xdp; XdpGtk4: XdpGtk4 | null; portal: InstanceType<Xdp['Portal']> }> | null = null;
  const load = () =>
    (loaded ??= (async () => {
      const Xdp: Xdp = (await import('gi://Xdp?version=1.0')).default;
      let XdpGtk4: XdpGtk4 | null = null;
      if (options.parent) XdpGtk4 = (await import('gi://XdpGtk4?version=1.0')).default;
      return { Xdp, XdpGtk4, portal: Xdp.Portal.new() };
    })());

  const ask = async (autostart: boolean): Promise<AutostartResult> => {
    try {
      const { Xdp, XdpGtk4, portal } = await load();
      const window = options.parent?.() ?? null;
      const parent = window && XdpGtk4 ? XdpGtk4.parent_new_gtk(window as unknown as Parameters<XdpGtk4['parent_new_gtk']>[0]) : null;
      const wish = backgroundRequest(autostart, options.commandline);
      const granted = await new Promise<boolean>((resolve, reject) => {
        portal.request_background(
          parent,
          options.reason,
          wish.commandline,
          wish.autostart ? Xdp.BackgroundFlags.AUTOSTART : Xdp.BackgroundFlags.NONE,
          null,
          (_source: unknown, result: PortalResult) => {
            try {
              resolve(portal.request_background_finish(result));
            } catch (error) {
              reject(error);
            }
          },
        );
      });
      return backgroundResult(granted, autostart);
    } catch (error) {
      console.warn(`Background portal request failed (autostart=${autostart}):`, error);
      return unavailableResult();
    }
  };
  return {
    needsUnitFile: false,
    status: async () => 'unknown',
    enable: () => ask(true),
    disable: () => ask(false),
  };
}

/** The driver for this run: the portal inside a sandbox, the systemd user unit outside. */
export function autostartFor(host: CommandRunner): Autostart {
  return inSandbox()
    ? portalAutostart({
        commandline: ['curlew', 'daemon'],
        reason: _('Keep receiving messages while the window is closed'),
      })
    : systemdAutostart(host);
}
