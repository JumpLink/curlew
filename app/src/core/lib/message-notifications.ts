/**
 * The daemon's message notifications on the session bus: the desktop's own service
 * (`org.freedesktop.Notifications`) outside a sandbox, the Notification portal inside one.
 *
 * Transport only: WHICH messages announce and what they say is `message-notices.ts`. One
 * notification per chat, replaced in place as more messages come, so a busy chat is one entry in
 * the shell and not a stack. Clicking it opens the window at that chat.
 */

import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import { _ } from '@curlew/protocol';
import type { Notice } from './message-notices.ts';
import { inSandbox } from './sandbox.ts';

const NOTIFICATIONS_NAME = 'org.freedesktop.Notifications';
const NOTIFICATIONS_PATH = '/org/freedesktop/Notifications';
const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const PORTAL_NOTIFICATION = 'org.freedesktop.portal.Notification';
const APP_ID = 'eu.jumplink.curlew';
const APP_PATH = '/eu/jumplink/curlew';
const OPEN_ACTION = 'open-conversation';

/** Where a notice goes. The daemon owns one for its run and closes it at the end. */
export interface NoticeSink {
  show(notice: Notice): void;
  close(): void;
}

/**
 * Open the window at a chat: a running window takes the `app.open-conversation` action over the
 * bus; with none running the desktop entry starts one, told by its environment which chat to open.
 */
function openChat(connection: Gio.DBusConnection, conversationId: string): void {
  connection.call(
    APP_ID,
    APP_PATH,
    'org.freedesktop.Application',
    'ActivateAction',
    new GLib.Variant('(sava{sv})', [OPEN_ACTION, [new GLib.Variant('s', conversationId)], {}]),
    null,
    Gio.DBusCallFlags.NO_AUTO_START,
    5_000,
    null,
    (_source, result) => {
      try {
        connection.call_finish(result!);
      } catch {
        launchWindow(conversationId);
      }
    },
  );
}

function launchWindow(conversationId: string): void {
  try {
    const entry = Gio.AppInfo.get_all().find((app) => app.get_id() === `${APP_ID}.desktop`);
    if (!entry) return;
    const context = new Gio.AppLaunchContext();
    context.setenv('CURLEW_WINDOW_OPEN', conversationId);
    entry.launch([], context);
  } catch {
    // No desktop entry installed: the notification still did its job.
  }
}

/**
 * The sink behind the Notification portal. The portal knows the app from the sandbox, not from
 * what is sent, and reports a click to that application id: the window takes the
 * `open-conversation` action itself, or the desktop entry starts one. The daemon forwards
 * nothing, so it needs no action of its own. The same id replaces a chat's earlier notification.
 */
function portalNoticeSink(): NoticeSink {
  let connection: Gio.DBusConnection | null = null;
  try {
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
  } catch {
    // Without a session bus there is nowhere to show anything.
  }
  return {
    show: (notice) => {
      connection?.call(
        PORTAL_NAME,
        PORTAL_PATH,
        PORTAL_NOTIFICATION,
        'AddNotification',
        new GLib.Variant('(sa{sv})', [
          notice.conversationId,
          {
            title: new GLib.Variant('s', notice.title),
            body: new GLib.Variant('s', notice.body),
            category: new GLib.Variant('s', 'im.received'),
            'default-action': new GLib.Variant('s', OPEN_ACTION),
            'default-action-target': new GLib.Variant('v', new GLib.Variant('s', notice.conversationId)),
          },
        ]),
        null,
        Gio.DBusCallFlags.NO_AUTO_START,
        10_000,
        null,
        (_source, result) => {
          try {
            connection?.call_finish(result!);
          } catch {
            // No portal on this system.
          }
        },
      );
    },
    close: () => {},
  };
}

/**
 * The sink for this run: the portal in a sandbox, the desktop's service outside. With no bus or
 * no notification service a notice is dropped.
 */
export function gioNoticeSink(): NoticeSink {
  return inSandbox() ? portalNoticeSink() : fdoNoticeSink();
}

function fdoNoticeSink(): NoticeSink {
  let connection: Gio.DBusConnection | null = null;
  try {
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
  } catch {
    // Without a session bus there is nowhere to show anything.
  }
  const shownByChat = new Map<string, number>();
  const chatOfId = new Map<number, string>();
  const subscriptions: number[] = [];

  const listen = (name: string, handler: (params: GLib.Variant) => void): void => {
    if (!connection) return;
    subscriptions.push(
      connection.signal_subscribe(
        NOTIFICATIONS_NAME,
        NOTIFICATIONS_NAME,
        name,
        NOTIFICATIONS_PATH,
        null,
        Gio.DBusSignalFlags.NONE,
        ((_c: unknown, _s: unknown, _p: unknown, _i: unknown, _n: unknown, params: GLib.Variant) =>
          handler(params)) as unknown as Parameters<Gio.DBusConnection['signal_subscribe']>[6],
      ),
    );
  };
  listen('ActionInvoked', (params) => {
    const [id, key] = params.recursiveUnpack() as [number, string];
    const chat = chatOfId.get(id);
    if (chat !== undefined && key === 'default' && connection) openChat(connection, chat);
  });
  listen('NotificationClosed', (params) => {
    const [id] = params.recursiveUnpack() as [number, number];
    const chat = chatOfId.get(id);
    if (chat === undefined) return;
    chatOfId.delete(id);
    if (shownByChat.get(chat) === id) shownByChat.delete(chat);
  });

  return {
    show: (notice) => {
      const bus = connection;
      if (!bus) return;
      bus.call(
        NOTIFICATIONS_NAME,
        NOTIFICATIONS_PATH,
        NOTIFICATIONS_NAME,
        'Notify',
        new GLib.Variant('(susssasa{sv}i)', [
          'Curlew',
          shownByChat.get(notice.conversationId) ?? 0,
          APP_ID,
          notice.title,
          notice.body,
          ['default', _('Open')],
          {
            'desktop-entry': new GLib.Variant('s', APP_ID),
            category: new GLib.Variant('s', 'im.received'),
          },
          -1,
        ]),
        new GLib.VariantType('(u)'),
        Gio.DBusCallFlags.NO_AUTO_START,
        10_000,
        null,
        (_source, result) => {
          try {
            const [id] = bus.call_finish(result!).recursiveUnpack() as [number];
            shownByChat.set(notice.conversationId, id);
            chatOfId.set(id, notice.conversationId);
          } catch {
            // No notification service on this desktop.
          }
        },
      );
    },
    close: () => {
      for (const subscription of subscriptions) connection?.signal_unsubscribe(subscription);
      subscriptions.length = 0;
    },
  };
}
