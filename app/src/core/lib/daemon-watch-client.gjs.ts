/**
 * The Gio side of `DaemonChangeSource`: watch who owns `eu.jumplink.curlew.Daemon` and forward
 * its `Changed`. One `bus_watch_name_on_connection` reports the owner at start and on every
 * change, so a daemon that starts, restarts or stops later is followed without polling the bus.
 * The signal subscription names the well-known name as sender; GDBus tracks its current owner,
 * so it survives a restart and needs no re-subscribe.
 */

import Gio from 'gi://Gio?version=2.0';
import type GLib from 'gi://GLib?version=2.0';
import { DAEMON_BUS_NAME, DAEMON_INTERFACE, DAEMON_OBJECT_PATH } from './daemon-bus.ts';
import type { DaemonChangeSource } from './daemon-watch.ts';

export function gioDaemonChangeSource(): DaemonChangeSource {
  return {
    follow: (handlers) => {
      let connection: Gio.DBusConnection;
      try {
        connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
      } catch {
        handlers.owner(false);
        return () => {};
      }
      const subscription = connection.signal_subscribe(
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
        ) => handlers.changed(Number((params.recursiveUnpack() as [number | bigint])[0]))) as unknown as Parameters<
          Gio.DBusConnection['signal_subscribe']
        >[6],
      );
      const watch = Gio.bus_watch_name_on_connection(
        connection,
        DAEMON_BUS_NAME,
        Gio.BusNameWatcherFlags.NONE,
        () => handlers.owner(true),
        () => handlers.owner(false),
      );
      return () => {
        Gio.bus_unwatch_name(watch);
        connection.signal_unsubscribe(subscription);
      };
    },
  };
}
