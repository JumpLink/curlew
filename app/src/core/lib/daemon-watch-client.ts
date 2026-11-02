/**
 * The listener's side of `Changed` (ADR 0007 §2): subscribe to the daemon's signal on the session
 * bus. A port with one Gio implementation for the same reason `daemon-send-client.ts` is one — the
 * test suite runs with no session bus, so `watch` is tested against an injected source.
 *
 * `null` from `subscribe` means ONE thing: no daemon owns the bus name, and the caller polls the
 * journal itself.
 */

import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import { DAEMON_BUS_NAME, DAEMON_INTERFACE, DAEMON_OBJECT_PATH } from './daemon-bus.ts';

export interface DaemonChangeSource {
  /** Call `onChanged(seq)` for every `Changed`; returns how to stop, or `null` without a daemon. */
  subscribe(onChanged: (seq: number) => void): (() => void) | null;
}

export function gioDaemonChangeSource(): DaemonChangeSource {
  return {
    subscribe: (onChanged) => {
      let connection: Gio.DBusConnection;
      try {
        connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
      } catch {
        return null;
      }
      try {
        const owned = connection.call_sync(
          'org.freedesktop.DBus',
          '/org/freedesktop/DBus',
          'org.freedesktop.DBus',
          'NameHasOwner',
          new GLib.Variant('(s)', [DAEMON_BUS_NAME]),
          new GLib.VariantType('(b)'),
          Gio.DBusCallFlags.NO_AUTO_START,
          2_000,
          null,
        );
        if (!(owned.recursiveUnpack() as [boolean])[0]) return null;
      } catch {
        return null;
      }
      const id = connection.signal_subscribe(
        DAEMON_BUS_NAME,
        DAEMON_INTERFACE,
        'Changed',
        DAEMON_OBJECT_PATH,
        null,
        Gio.DBusSignalFlags.NONE,
        ((
          _connection: Gio.DBusConnection,
          _sender: string,
          _path: string,
          _iface: string,
          _signal: string,
          params: GLib.Variant,
        ) => onChanged(Number((params.recursiveUnpack() as [number | bigint])[0]))) as unknown as Parameters<
          Gio.DBusConnection['signal_subscribe']
        >[6],
      );
      return () => connection.signal_unsubscribe(id);
    },
  };
}
