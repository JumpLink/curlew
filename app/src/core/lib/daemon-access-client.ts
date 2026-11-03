/**
 * The caller's side of the daemon's prompt service (ADR 0009, step 3): ask the running
 * `curlew daemon` whether an agent may write to, or read from, one contact.
 *
 * A port with one Gio implementation for the reason `daemon-send-client.ts` gives: the tests run
 * with no session bus, so the enforcement is tested against an injected `AccessPort` and the
 * transport against a real bus (`app/tests/integration/daemon-access-dbus.ts`).
 *
 * `null` means no daemon answered — also a daemon that is too old to know `RequestAccess` — and
 * the enforcement turns it into a refusal that says nobody could be asked.
 */

import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import { _, fmt } from '@curlew/protocol';
import type { AccessAsk, AccessPort, AccessReply } from '../access.ts';
import {
  DAEMON_ACCESS_TIMEOUT_MS,
  DAEMON_BUS_NAME,
  DAEMON_INTERFACE,
  DAEMON_OBJECT_PATH,
  DAEMON_WIRE_VERSION,
  parseDaemonAccessReply,
} from './daemon-bus.ts';

const NO_PROMPT_SERVICE = [
  'org.freedesktop.DBus.Error.ServiceUnknown',
  'org.freedesktop.DBus.Error.NameHasNoOwner',
  'org.freedesktop.DBus.Error.UnknownMethod',
];

function noPromptService(error: unknown): boolean {
  try {
    const name = Gio.DBusError.get_remote_error(error as GLib.Error);
    if (name) return NO_PROMPT_SERVICE.includes(name);
  } catch {
    // Not a GError this runtime hands over as such; the text carries the name too.
  }
  const text = error instanceof Error ? error.message : String(error);
  return NO_PROMPT_SERVICE.some((name) => text.includes(name));
}

export function gioAccessClient(): AccessPort {
  return {
    request: async (ask: AccessAsk): Promise<AccessReply | null> => {
      let connection: Gio.DBusConnection;
      try {
        connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
      } catch {
        return null;
      }
      let json: string;
      try {
        json = await new Promise<string>((resolve, reject) => {
          connection.call(
            DAEMON_BUS_NAME,
            DAEMON_OBJECT_PATH,
            DAEMON_INTERFACE,
            'RequestAccess',
            new GLib.Variant('(s)', [JSON.stringify({ v: DAEMON_WIRE_VERSION, ...ask })]),
            new GLib.VariantType('(s)'),
            // A question is no reason to start a daemon: with none running nobody can answer.
            Gio.DBusCallFlags.NO_AUTO_START,
            DAEMON_ACCESS_TIMEOUT_MS,
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
        if (noPromptService(error)) return null;
        throw new Error(
          fmt(_('the running curlew daemon did not answer the access prompt ({reason})'), {
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return parseDaemonAccessReply(json);
    },
  };
}
