/**
 * The Background portal as the `Autostart` driver inside a sandbox (ADR 0011).
 *
 * `RequestBackground` answers on a `Request` object, not on the call: the response signal names
 * whether the person allowed it, and the portal shows its own dialog the first time. It has no
 * query, so `status()` is `unknown`; the answer to the last request is not recorded here because a
 * person can revoke it in the system settings behind our back.
 */

import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import { _ } from '@curlew/protocol';
import { systemdAutostart, type Autostart, type AutostartResult } from '../actions/autostart.ts';
import type { CommandRunner } from '../actions/setup-host.ts';
import { inSandbox } from './sandbox.ts';

const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const BACKGROUND = 'org.freedesktop.portal.Background';
const REQUEST = 'org.freedesktop.portal.Request';
const REQUEST_TIMEOUT_MS = 120_000;

export interface PortalAutostartOptions {
  /** What the portal starts at login: `curlew daemon`, as the sandbox sees it. */
  commandline: string[];
  /** Shown by the portal's dialog. */
  reason: string;
}

export function portalAutostart(options: PortalAutostartOptions): Autostart {
  const ask = (autostart: boolean): Promise<AutostartResult> =>
    new Promise((resolve) => {
      let connection: Gio.DBusConnection;
      try {
        connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
      } catch {
        resolve({ ok: false, reason: _('no session bus') });
        return;
      }
      // The Request path is predictable, so the subscription exists before the call can answer.
      const token = `curlew_${GLib.random_int()}`;
      const sender = (connection.get_unique_name() ?? '').replace(/^:/, '').replace(/\./g, '_');
      const requestPath = `${PORTAL_PATH}/request/${sender}/${token}`;
      let timer = 0;
      let subscription = 0;
      const finish = (result: AutostartResult): void => {
        if (timer) GLib.source_remove(timer);
        if (subscription) connection.signal_unsubscribe(subscription);
        timer = 0;
        subscription = 0;
        resolve(result);
      };
      subscription = connection.signal_subscribe(
        PORTAL_NAME,
        REQUEST,
        'Response',
        requestPath,
        null,
        Gio.DBusSignalFlags.NONE,
        ((_c: unknown, _s: unknown, _p: unknown, _i: unknown, _n: unknown, params: GLib.Variant) => {
          const [response, results] = params.recursiveUnpack() as [number, Record<string, unknown>];
          if (response === 0 && results.autostart === autostart) finish({ ok: true });
          else if (response === 1) finish({ ok: false, reason: _('declined in the permission dialog') });
          else finish({ ok: false, reason: _('the portal did not allow it') });
        }) as unknown as Parameters<Gio.DBusConnection['signal_subscribe']>[6],
      );
      timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_MS, () => {
        timer = 0;
        finish({ ok: false, reason: _('the portal did not answer') });
        return GLib.SOURCE_REMOVE;
      });
      connection.call(
        PORTAL_NAME,
        PORTAL_PATH,
        BACKGROUND,
        'RequestBackground',
        new GLib.Variant('(sa{sv})', [
          '',
          {
            handle_token: new GLib.Variant('s', token),
            reason: new GLib.Variant('s', options.reason),
            autostart: new GLib.Variant('b', autostart),
            commandline: new GLib.Variant('as', options.commandline),
            'dbus-activatable': new GLib.Variant('b', false),
          },
        ]),
        null,
        Gio.DBusCallFlags.NONE,
        10_000,
        null,
        (_source, result) => {
          try {
            connection.call_finish(result!);
          } catch {
            finish({ ok: false, reason: _('no Background portal on this system') });
          }
        },
      );
    });
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
