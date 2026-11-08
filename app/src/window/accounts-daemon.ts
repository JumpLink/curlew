/**
 * Live daemon state for the Accounts dialog: who owns the curlew bus name, a `GetAccounts` query
 * when the name appears, and an `AccountsChanged` subscription while it is held.
 */

import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { UNIT_NAME } from '../core/actions/setup-unit.ts';
import {
  DAEMON_BUS_NAME,
  DAEMON_INTERFACE,
  DAEMON_OBJECT_PATH,
  type DaemonAccountEntry,
  parseDaemonAccountsReply,
} from '../core/lib/daemon-bus.ts';
import type { AccountsDaemonState } from './accounts-model.ts';

const GET_ACCOUNTS_TIMEOUT_MS = 10_000;

export interface AccountsDaemonSource {
  /** Follow the daemon and call `onChange` whenever the account list may have changed. */
  start(onChange: (state: AccountsDaemonState) => void): () => void;
}

/** The daemon reads its account list once at start, so a change to it takes effect on a restart. */
export function restartDaemonIfRunning(): void {
  try {
    Gio.Subprocess.new(['systemctl', '--user', 'try-restart', UNIT_NAME], Gio.SubprocessFlags.NONE);
  } catch {
    // No systemd user session: the next start of the daemon reads the new account list.
  }
}

function entryMap(accounts: DaemonAccountEntry[]): Map<string, DaemonAccountEntry> {
  const map = new Map<string, DaemonAccountEntry>();
  for (const account of accounts) map.set(`${account.backend}/${account.accountId}`, account);
  return map;
}

async function queryAccounts(connection: Gio.DBusConnection): Promise<DaemonAccountEntry[]> {
  const json = await new Promise<string>((resolve, reject) => {
    connection.call(
      DAEMON_BUS_NAME,
      DAEMON_OBJECT_PATH,
      DAEMON_INTERFACE,
      'GetAccounts',
      null,
      new GLib.VariantType('(s)'),
      Gio.DBusCallFlags.NO_AUTO_START,
      GET_ACCOUNTS_TIMEOUT_MS,
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
  return parseDaemonAccountsReply(json).accounts;
}

export function gioAccountsDaemonSource(): AccountsDaemonSource {
  return {
    start: (onChange) => {
      let connection: Gio.DBusConnection;
      try {
        connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
      } catch {
        onChange({ present: false, accounts: new Map() });
        return () => {};
      }

      let present = false;
      let subscription = 0;
      let watch = 0;

      const emit = () => onChange({ present, accounts: new Map() });

      const refresh = async () => {
        if (!present) return;
        try {
          const accounts = await queryAccounts(connection);
          onChange({ present: true, accounts: entryMap(accounts) });
        } catch {
          // The daemon vanished mid-call; the owner handler will report absence next.
          emit();
        }
      };

      subscription = connection.signal_subscribe(
        DAEMON_BUS_NAME,
        DAEMON_INTERFACE,
        'AccountsChanged',
        DAEMON_OBJECT_PATH,
        null,
        Gio.DBusSignalFlags.NONE,
        (() => void refresh()) as unknown as Parameters<Gio.DBusConnection['signal_subscribe']>[6],
      );

      watch = Gio.bus_watch_name_on_connection(
        connection,
        DAEMON_BUS_NAME,
        Gio.BusNameWatcherFlags.NONE,
        () => {
          present = true;
          void refresh();
        },
        () => {
          present = false;
          emit();
        },
      );

      return () => {
        Gio.bus_unwatch_name(watch);
        connection.signal_unsubscribe(subscription);
      };
    },
  };
}
