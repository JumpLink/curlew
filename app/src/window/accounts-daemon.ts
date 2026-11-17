/**
 * Live daemon state for the Accounts dialog: who owns the curlew bus name, a `GetAccounts` query
 * when the name appears, and an `AccountsChanged` subscription while it is held.
 */

import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { _, fmt } from '@curlew/protocol';

import { demoActive } from '../core/demo/active.ts';
import { DEMO_ACCOUNTS } from '../core/demo/accounts.ts';
import { detectSetup, nodeHost, systemdUserUnitDir, writeFileEnsured } from '../core/actions/setup-host.ts';
import { renderUnit, UNIT_NAME, unitFilePath, unitPathsFor } from '../core/actions/setup-unit.ts';
import { portalAutostart } from '../core/lib/autostart-portal.ts';
import { inSandbox } from '../core/lib/sandbox.ts';
import { backgroundService } from '../core/platform.ts';
import {
  DAEMON_BUS_NAME,
  DAEMON_INTERFACE,
  DAEMON_OBJECT_PATH,
  type DaemonAccountEntry,
  parseDaemonAccountsReply,
} from '../core/lib/daemon-bus.ts';
import { reportWireMismatch } from '../core/lib/wire-mismatch.ts';
import { createPresenceGate } from '../core/lib/daemon-watch.ts';
import { stateAfterQueryError, type AccountsDaemonState } from './accounts-model.ts';

const GET_ACCOUNTS_TIMEOUT_MS = 10_000;

/** Sources following the daemon, told when the window restarts it so a short vanish is not an absence. */
const restartListeners = new Set<() => void>();

export interface AccountsDaemonSource {
  /** Follow the daemon and call `onChange` whenever the account list may have changed. */
  start(onChange: (state: AccountsDaemonState) => void): () => void;
}

/** The daemon reads its account list once at start, so a change to it takes effect on a restart. */
export function restartDaemonIfRunning(): void {
  if (demoActive()) return;
  // No systemd to ask: the window's own receive loop reads the account list when it starts.
  if (backgroundService() === 'while-open') return;
  // A sandbox has no systemd: the Background portal starts the daemon at the next login.
  if (inSandbox()) return;
  try {
    Gio.Subprocess.new(['systemctl', '--user', 'try-restart', UNIT_NAME], Gio.SubprocessFlags.NONE);
    for (const listener of restartListeners) listener();
  } catch {
    // No systemd user session: the next start of the daemon reads the new account list.
  }
}

/** Run `systemctl --user` and resolve with whether it succeeded, plus what it said on stderr. */
function systemctl(args: string[]): Promise<{ ok: boolean; reason: string }> {
  return new Promise((resolve) => {
    try {
      const process = Gio.Subprocess.new(['systemctl', '--user', ...args], Gio.SubprocessFlags.STDERR_PIPE);
      process.communicate_utf8_async(null, null, (_source, result) => {
        try {
          const [, , stderr] = process.communicate_utf8_finish(result);
          resolve({ ok: process.get_successful(), reason: (stderr ?? '').trim() });
        } catch (error) {
          resolve({ ok: false, reason: (error as Error).message });
        }
      });
    } catch (error) {
      resolve({ ok: false, reason: (error as Error).message });
    }
  });
}

/** Write the user unit for this machine, the way `curlew setup` does. */
function writeUserUnit(): void {
  const host = nodeHost();
  // A checkout's unit must run out of its tree (the addon path is baked in), so find it the way
  // `curlew setup` does; anything else is a published install that runs the command.
  let setup: { mode: 'checkout' | 'published'; checkout: string | null };
  try {
    setup = detectSetup(host);
  } catch {
    setup = { mode: 'published', checkout: null };
  }
  const paths = unitPathsFor({
    mode: setup.mode,
    home: host.home(),
    checkout: setup.checkout,
    gjsify: host.which('gjsify'),
    bundle: host.bundlePath(),
  });
  writeFileEnsured(host, unitFilePath(systemdUserUnitDir(host)), renderUnit(paths));
}

/**
 * Start the background service. When the machine has no unit yet, the window installs it, then
 * enables and starts it; on success the bus watch reports the daemon as present.
 */
export async function startDaemon(): Promise<void> {
  if (demoActive()) return;
  // Nothing to start: the window receives while it is open.
  if (backgroundService() === 'while-open') return;
  if (inSandbox()) return startDaemonThroughPortal();
  const started = await systemctl(['start', UNIT_NAME]);
  if (started.ok) return;
  let reason = started.reason;
  try {
    writeUserUnit();
    const reloaded = await systemctl(['daemon-reload']);
    if (!reloaded.ok) reason = reloaded.reason;
    else {
      const enabled = await systemctl(['enable', '--now', UNIT_NAME]);
      if (enabled.ok) return;
      reason = enabled.reason;
    }
  } catch (error) {
    reason = (error as Error).message;
  }
  throw new Error(fmt(_('Could not start the background service: {reason}'), { reason }));
}

/** Inside a Flatpak the capability is "keep receiving", granted by the Background portal. */
async function startDaemonThroughPortal(): Promise<void> {
  const result = await portalAutostart({
    commandline: ['curlew', 'daemon'],
    reason: _('Keep receiving messages while the window is closed'),
  }).enable();
  if (!result.ok)
    throw new Error(fmt(_('Could not start the background service: {reason}'), { reason: result.reason }));
}

function isTimeout(error: unknown): boolean {
  return error instanceof GLib.Error && error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.TIMED_OUT);
}

/** Restart the background service so it speaks this build's wire version, as the window asks. */
export async function restartDaemon(): Promise<void> {
  if (demoActive()) return;
  if (backgroundService() === 'while-open' || inSandbox()) return startDaemon();
  const restarted = await systemctl(['restart', UNIT_NAME]);
  if (!restarted.ok) return startDaemon();
  for (const listener of restartListeners) listener();
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
      if (demoActive()) {
        // No daemon in demo mode: every made-up account shows as connected.
        const since = new Date().toISOString();
        const accounts = new Map<string, DaemonAccountEntry>();
        for (const a of DEMO_ACCOUNTS)
          accounts.set(`${a.provider}/${a.id}`, {
            backend: a.provider,
            accountId: a.id,
            state: 'connected',
            since,
          });
        onChange({ present: true, accounts });
        return () => {};
      }
      let connection: Gio.DBusConnection;
      try {
        connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
      } catch {
        onChange({ present: false, accounts: new Map() });
        return () => {};
      }

      // Unknown until the watcher answers: nothing is reported before that, so the page never shows an absence it has not seen.
      let present = false;
      let subscription = 0;
      let watch = 0;

      const emit = () => onChange({ present, accounts: new Map() });

      const refresh = async () => {
        if (!present) return;
        try {
          const accounts = await queryAccounts(connection);
          onChange({ present: true, accounts: entryMap(accounts) });
        } catch (error) {
          reportWireMismatch(error);
          // A mismatch or a silent daemon settles the dialog; a vanished one is the presence gate's call.
          const settled = stateAfterQueryError(error, isTimeout(error));
          if (settled) onChange(settled);
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

      const gate = createPresenceGate(
        (presence) => {
          present = presence === 'present';
          if (present) void refresh();
          else if (presence === 'absent') emit();
        },
        {
          set: (callback, ms) =>
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => (callback(), GLib.SOURCE_REMOVE)),
          clear: (handle) => void GLib.source_remove(handle as number),
        },
      );
      const onRestart = () => gate.expectRestart();
      restartListeners.add(onRestart);

      watch = Gio.bus_watch_name_on_connection(
        connection,
        DAEMON_BUS_NAME,
        Gio.BusNameWatcherFlags.NONE,
        () => gate.owner(true),
        () => gate.owner(false),
      );

      return () => {
        restartListeners.delete(onRestart);
        gate.dispose();
        Gio.bus_unwatch_name(watch);
        connection.signal_unsubscribe(subscription);
      };
    },
  };
}
