/**
 * The daemon's side of the send interface: own `eu.jumplink.curlew.Daemon` on the session bus and
 * answer `Send` (ADR 0004, amendment 2026-10-30, daemon send).
 *
 * Transport only. WHAT a request is allowed to do — the grant re-check against this daemon's own
 * freshly loaded config, which account it holds a session for, and the send itself — is the
 * handler's, in `daemon.ts`, where it can be tested without a bus.
 *
 * Raw `register_object` and `bus_own_name_on_connection`, not `Gio.DBusExportedObject`: that
 * wrapper is a GJS-only override and curlew runs on node-gi too.
 */

import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import {
  DAEMON_BUS_NAME,
  DAEMON_INTERFACE,
  DAEMON_INTERFACE_XML,
  DAEMON_OBJECT_PATH,
  DAEMON_WIRE_VERSION,
  type DaemonAccountsReply,
  type DaemonAccessReply,
  type DaemonAccessRequest,
  type DaemonSendReply,
  type DaemonSendRequest,
  parseDaemonAccessRequest,
  parseDaemonSendRequest,
} from './daemon-bus.ts';
import type { AccessReply } from '../access.ts';

/** Answer one send. Never throws: every outcome is a reply, which is what the caller reads. */
export type DaemonSendHandler = (request: DaemonSendRequest) => Promise<DaemonSendReply>;

/** Answer one access question (ADR 0009). Never throws: every outcome is a reply. */
export type DaemonAccessHandler = (request: DaemonAccessRequest) => Promise<AccessReply>;

export interface DaemonSendService {
  /** `Changed(seq)`: the newest journal row (ADR 0007 §2). Carries a number, never content. */
  emitChanged(seq: number): void;
  /** `AccountsChanged`: ask again with `GetAccounts`. */
  emitAccountsChanged(): void;
  /** Give the name and the object back. Twice is fine. */
  close(): void;
}

export interface PublishOptions {
  /** One line per state change, as everywhere in the daemon: names and counts, never content. */
  log: (line: string) => void;
  /** What `GetAccounts` answers, read at the moment of the call. */
  accounts?: () => DaemonAccountsReply;
  /** Serves `RequestAccess`. Absent: the method answers `UnknownMethod`, as an old daemon would. */
  access?: DaemonAccessHandler;
  /** A caller that asked left the bus: its session is over and so are its grants. */
  onSessionEnd?: (session: string) => void;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serve `Send` until the returned service is closed, or `null` when there is no session bus to
 * serve it on — then the daemon receives as it always did and a send falls back to its own direct
 * path, which refuses while this process holds the lease.
 */
export function publishDaemonSend(
  handler: DaemonSendHandler,
  options: PublishOptions,
): DaemonSendService | null {
  const log = options.log;
  let connection: Gio.DBusConnection;
  try {
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
  } catch (error) {
    log(
      `curlew-daemon: no session bus (${reasonOf(error)}) — a send cannot be routed through this daemon`,
    );
    return null;
  }

  const iface = Gio.DBusNodeInfo.new_for_xml(DAEMON_INTERFACE_XML).lookup_interface(DAEMON_INTERFACE);
  if (!iface) throw new Error(`the interface ${DAEMON_INTERFACE} is not in the introspection XML`);

  // One watch per caller that asked: a vanished MCP process ends the sessions it opened.
  const watched = new Map<string, { watchId: number; sessions: Set<string> }>();
  const watchCaller = (sender: string, session: string): void => {
    const known = watched.get(sender);
    if (known) {
      known.sessions.add(session);
      return;
    }
    const entry = { watchId: 0, sessions: new Set([session]) };
    watched.set(sender, entry);
    entry.watchId = Gio.bus_watch_name_on_connection(
      connection,
      sender,
      Gio.BusNameWatcherFlags.NONE,
      null,
      (() => {
        if (watched.get(sender) !== entry) return;
        watched.delete(sender);
        for (const ended of entry.sessions) options.onSessionEnd?.(ended);
        Gio.bus_unwatch_name(entry.watchId);
      }) as unknown as Parameters<typeof Gio.bus_watch_name_on_connection>[4],
    );
  };

  const onMethodCall = (
    _connection: Gio.DBusConnection,
    sender: string,
    _path: string,
    _ifaceName: string,
    method: string,
    params: GLib.Variant,
    invocation: Gio.DBusMethodInvocation,
  ): void => {
    if (method === 'GetAccounts') {
      const reply: DaemonAccountsReply = options.accounts?.() ?? { v: DAEMON_WIRE_VERSION, accounts: [] };
      invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(reply)]));
      return;
    }
    if (method === 'RequestAccess' && options.access) {
      let request: DaemonAccessRequest;
      try {
        request = parseDaemonAccessRequest((params.recursiveUnpack() as [string])[0]);
      } catch (error) {
        invocation.return_dbus_error('org.freedesktop.DBus.Error.InvalidArgs', reasonOf(error));
        return;
      }
      watchCaller(sender, request.session);
      options.access(request).then(
        (reply) => {
          const wire: DaemonAccessReply = { v: DAEMON_WIRE_VERSION, ...reply };
          invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(wire)]));
        },
        (error: unknown) => {
          log(`curlew-daemon: the access handler threw — ${reasonOf(error)}`);
          invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', reasonOf(error));
        },
      );
      return;
    }
    if (method !== 'Send') {
      invocation.return_dbus_error('org.freedesktop.DBus.Error.UnknownMethod', `no method ${method}`);
      return;
    }
    let request: DaemonSendRequest;
    try {
      request = parseDaemonSendRequest((params.recursiveUnpack() as [string])[0]);
    } catch (error) {
      // A malformed request is a defect in the caller or a version mismatch, which is what D-Bus
      // errors are for — a `refused` reply would read as "the user may not do this".
      invocation.return_dbus_error('org.freedesktop.DBus.Error.InvalidArgs', reasonOf(error));
      return;
    }
    // The handler owns every outcome, so a throw out of it is a bug — reported as one, and never
    // as a refusal the caller might read as "nothing was sent for a good reason".
    handler(request).then(
      (reply) => invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(reply)])),
      (error: unknown) => {
        log(`curlew-daemon: the send handler threw — ${reasonOf(error)}`);
        invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', reasonOf(error));
      },
    );
  };

  const registered = connection.register_object(
    DAEMON_OBJECT_PATH,
    iface,
    onMethodCall as unknown as Parameters<Gio.DBusConnection['register_object']>[2],
    null,
    null,
  );
  const ownerId = Gio.bus_own_name_on_connection(
    connection,
    DAEMON_BUS_NAME,
    // Never queue behind another owner: a second daemon that acquired the name later would start
    // answering sends for accounts the FIRST one holds the sessions of.
    Gio.BusNameOwnerFlags.DO_NOT_QUEUE,
    (() => log('curlew-daemon: serving sends on the session bus')) as unknown as Parameters<
      typeof Gio.bus_own_name_on_connection
    >[3],
    (() =>
      log(
        `curlew-daemon: another process owns ${DAEMON_BUS_NAME} — a send is not routed through this daemon`,
      )) as unknown as Parameters<typeof Gio.bus_own_name_on_connection>[4],
  );

  const emit = (name: string, parameters: GLib.Variant | null): void => {
    try {
      connection.emit_signal(null, DAEMON_OBJECT_PATH, DAEMON_INTERFACE, name, parameters);
    } catch (error) {
      log(`curlew-daemon: could not emit ${name} (${reasonOf(error)})`);
    }
  };
  let closed = false;
  return {
    emitChanged: (seq) => {
      if (!closed) emit('Changed', new GLib.Variant('(t)', [seq]));
    },
    emitAccountsChanged: () => {
      if (!closed) emit('AccountsChanged', null);
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const entry of watched.values()) Gio.bus_unwatch_name(entry.watchId);
      watched.clear();
      Gio.bus_unown_name(ownerId);
      connection.unregister_object(registered);
    },
  };
}
