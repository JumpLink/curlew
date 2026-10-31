/**
 * The caller's side of the daemon send interface: ask the running `curlew daemon` to send on the
 * connection it is already holding (ADR 0004, amendment 2026-10-30, daemon send).
 *
 * It is a port with one Gio implementation, not a function, because the test suite runs with
 * `DBUS_SESSION_BUS_ADDRESS` pinned to a path that does not exist — there is no session bus to
 * talk to, by design, so the routing in `send.ts` is tested against an injected client and the
 * transport itself against a real bus by hand (`app/tests/integration/daemon-send-dbus.ts`).
 *
 * `null` from `send` means ONE thing: no daemon answered, so the caller's own direct path is free
 * to take the account. Everything else is an answer (`DaemonSendReply`) or a throw.
 */

import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import { _, fmt } from '@curlew/protocol';
import {
  DAEMON_BUS_NAME,
  DAEMON_INTERFACE,
  DAEMON_OBJECT_PATH,
  DAEMON_SEND_TIMEOUT_MS,
  type DaemonSendReply,
  type DaemonSendRequest,
  parseDaemonSendReply,
} from './daemon-bus.ts';

/** How a send reaches a daemon. Injected by tests; `gioDaemonSendClient` is the real one. */
export interface DaemonSendClient {
  /** The daemon's answer, or `null` when no daemon is there to answer. */
  send(request: DaemonSendRequest): Promise<DaemonSendReply | null>;
}

/**
 * The D-Bus error names that mean "nobody owns that name": no daemon is running, which is a
 * normal state and not a failure. `ServiceUnknown` is what a call to an unowned name answers with
 * (`NO_AUTO_START` keeps the bus from trying to start something for it); `NameHasNoOwner` is what
 * the bus driver itself says.
 */
const NO_DAEMON = ['org.freedesktop.DBus.Error.ServiceUnknown', 'org.freedesktop.DBus.Error.NameHasNoOwner'];

/**
 * Whether an error off the bus means there is no daemon.
 *
 * `Gio.DBusError.get_remote_error` is the right question to ask, but it wants a GError and the two
 * runtimes present a thrown one differently — so a failure to ask is not a failure to answer: the
 * error's own text carries the name too, and matching it is a weaker check used only as a
 * fallback.
 */
function meansNoDaemon(error: unknown): boolean {
  try {
    const name = Gio.DBusError.get_remote_error(error as GLib.Error);
    if (name) return NO_DAEMON.includes(name);
  } catch {
    // Not a GError, or not one this runtime hands over as such.
  }
  const text = error instanceof Error ? error.message : String(error);
  return NO_DAEMON.some((name) => text.includes(name));
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function gioDaemonSendClient(): DaemonSendClient {
  return {
    send: async (request) => {
      let connection: Gio.DBusConnection;
      try {
        connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
      } catch {
        // No session bus at all (a cron job, a login without one). Then there is no daemon to
        // reach either, and the direct path is the right one — it takes the receive lease and
        // refuses on its own if some process really does hold the account.
        return null;
      }
      let json: string;
      try {
        json = await new Promise<string>((resolve, reject) => {
          connection.call(
            DAEMON_BUS_NAME,
            DAEMON_OBJECT_PATH,
            DAEMON_INTERFACE,
            'Send',
            new GLib.Variant('(s)', [JSON.stringify(request)]),
            new GLib.VariantType('(s)'),
            // Never start a daemon for this: a send is not a reason to put a receiving process on
            // the machine, and "not running" is an answer this caller knows what to do with.
            Gio.DBusCallFlags.NO_AUTO_START,
            DAEMON_SEND_TIMEOUT_MS,
            null,
            (_source, result) => {
              try {
                resolve((connection.call_finish(result!).recursiveUnpack() as [string])[0]);
              } catch (error) {
                reject(error as Error);
              }
            },
          );
        });
      } catch (error) {
        if (meansNoDaemon(error)) return null;
        // The daemon is there and the call did not come back. It may have sent the message —
        // nothing may retry on its own from here.
        throw new Error(
          fmt(
            _(
              'the running curlew daemon did not answer ({reason}); it may have sent the message — look at the chat before sending it again',
            ),
            { reason: reasonOf(error) },
          ),
        );
      }
      return parseDaemonSendReply(json);
    },
  };
}
