/**
 * The daemon's prompt: ask the person about an agent request through a desktop notification
 * (`org.freedesktop.Notifications`, ADR 0009 step 3).
 *
 * The notification IS the prompt — no window, no extra process, and it works from a daemon that
 * runs as a user service. Four actions: Allow once · For this session (a CLI call has no session
 * and is not offered it) · Always · Deny. Closing it unanswered is a refusal, and so is no answer
 * within the broker's two minutes: the broker aborts the signal, and the notification is taken
 * down here.
 *
 * Transport only: WHICH answer means what is the broker's (`access-broker.ts`).
 */

import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import { _, fmt } from '@curlew/protocol';
import type { PromptChoice, PromptUi } from '../access-broker.ts';
import { ACCESS_PROMPT_TIMEOUT_MS, type AccessAsk } from '../access.ts';
import { sanitizeName } from './contact-name.ts';
import { inSandbox } from './sandbox.ts';

const NOTIFICATIONS_NAME = 'org.freedesktop.Notifications';
const NOTIFICATIONS_PATH = '/org/freedesktop/Notifications';
const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const PORTAL_NOTIFICATION = 'org.freedesktop.portal.Notification';

/** The action keys on the wire; `deny` is a button of its own, not just a closed notification. */
const ACTION_CHOICES: Record<string, PromptChoice> = {
  once: 'once',
  session: 'session',
  always: 'always',
  deny: 'deny',
};

/** What the notification says, in the person's language. Exported for the tests. */
export function promptText(ask: AccessAsk, name?: string): { summary: string; body: string } {
  const address = ask.contact === undefined ? ask.account : ask.contact;
  // `name` is the daemon's own lookup, never a field of the request (an agent could mislead).
  const shown = sanitizeName(name);
  const target = shown === undefined || ask.contact === undefined ? address : fmt(_('{name} ({address})'), { name: shown, address });
  const values = { contact: target, account: ask.account, preview: ask.preview ?? '' };
  if (ask.kind === 'write') {
    const head =
      ask.preview === undefined
        ? fmt(_('To {contact} ({account}).'), values)
        : fmt(_('To {contact} ({account}): “{preview}”'), values);
    const files = (ask.attachments ?? []).map((n) => sanitizeName(n) ?? '').filter((n) => n !== '');
    return {
      summary: _('An agent wants to send a message'),
      body: files.length === 0 ? head : `${head}\n${fmt(_('Attachments: {files}'), { files: files.join(', ') })}`,
    };
  }
  return {
    summary: _('An agent wants to read messages'),
    body: fmt(_('Messages of {contact} ({account}).'), values),
  };
}

function actionsFor(ask: AccessAsk): string[] {
  return [
    'once',
    _('Allow once'),
    ...(ask.oneShot ? [] : ['session', _('For this session')]),
    'always',
    _('Always'),
    'deny',
    _('Deny'),
  ];
}

export interface NotificationPromptOptions {
  nameOf?: (ask: AccessAsk) => string | undefined;
  /** Force a transport; by default the portal inside a sandbox, the desktop's service outside. */
  portal?: boolean;
}

/** The buttons of the prompt as the portal wants them; the action names carry no `app.` prefix. */
export function portalButtons(ask: AccessAsk): Array<{ action: string; label: string }> {
  const flat = actionsFor(ask);
  const buttons: Array<{ action: string; label: string }> = [];
  for (let i = 0; i < flat.length; i += 2) buttons.push({ action: flat[i], label: flat[i + 1] });
  return buttons;
}

let portalCounter = 0;

/**
 * The prompt through the Notification portal (a sandbox cannot talk to the desktop's service).
 * Buttons whose action name does not start with `app.` come back to the caller as the portal's
 * `ActionInvoked` signal. The portal reports no close, so an unanswered prompt ends with the
 * broker's timeout, which refuses just as a dismissal would.
 */
function portalPrompt(options: NotificationPromptOptions): PromptUi {
  return {
    ask: (ask, signal) =>
      new Promise<PromptChoice>((resolve) => {
        let connection: Gio.DBusConnection;
        try {
          connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        } catch {
          resolve('unavailable');
          return;
        }
        if (signal.aborted) {
          resolve('dismissed');
          return;
        }
        const notificationId = `access-${GLib.uuid_string_random()}-${++portalCounter}`;
        let subscription = 0;
        let done = false;
        const finish = (choice: PromptChoice): void => {
          if (done) return;
          done = true;
          if (subscription !== 0) connection.signal_unsubscribe(subscription);
          signal.removeEventListener('abort', onAbort);
          resolve(choice);
        };
        const onAbort = (): void => {
          connection.call(
            PORTAL_NAME,
            PORTAL_PATH,
            PORTAL_NOTIFICATION,
            'RemoveNotification',
            new GLib.Variant('(s)', [notificationId]),
            null,
            Gio.DBusCallFlags.NO_AUTO_START,
            5_000,
            null,
            null,
          );
          finish('dismissed');
        };
        signal.addEventListener('abort', onAbort, { once: true });

        // Subscribe BEFORE the call: a fast answer must not slip past a listener not yet there.
        subscription = connection.signal_subscribe(
          PORTAL_NAME,
          PORTAL_NOTIFICATION,
          'ActionInvoked',
          PORTAL_PATH,
          null,
          Gio.DBusSignalFlags.NONE,
          ((_c: unknown, _s: unknown, _p: unknown, _i: unknown, _n: unknown, params: GLib.Variant) => {
            const [id, key] = params.recursiveUnpack() as [string, string];
            if (id === notificationId && key in ACTION_CHOICES) finish(ACTION_CHOICES[key]);
          }) as unknown as Parameters<Gio.DBusConnection['signal_subscribe']>[6],
        );

        let name: string | undefined;
        try {
          name = options.nameOf?.(ask);
        } catch {
          // A name is convenience: the prompt shows the address without it.
        }
        const { summary, body } = promptText(ask, name);
        const buttons = portalButtons(ask).map((button) => ({
          label: new GLib.Variant('s', button.label),
          action: new GLib.Variant('s', button.action),
        }));
        connection.call(
          PORTAL_NAME,
          PORTAL_PATH,
          PORTAL_NOTIFICATION,
          'AddNotification',
          new GLib.Variant('(sa{sv})', [
            notificationId,
            {
              title: new GLib.Variant('s', summary),
              body: new GLib.Variant('s', body),
              priority: new GLib.Variant('s', 'high'),
              buttons: new GLib.Variant('aa{sv}', buttons),
            },
          ]),
          null,
          Gio.DBusCallFlags.NO_AUTO_START,
          10_000,
          null,
          (_source, result) => {
            try {
              connection.call_finish(result!);
            } catch {
              finish('unavailable');
            }
          },
        );
      }),
  };
}

/** The prompt as a notification on the session bus; no bus or no notification service is `unavailable`. */
export function gioNotificationPrompt(options: NotificationPromptOptions = {}): PromptUi {
  return (options.portal ?? inSandbox()) ? portalPrompt(options) : fdoPrompt(options);
}

function fdoPrompt(options: NotificationPromptOptions): PromptUi {
  return {
    ask: (ask, signal) =>
      new Promise<PromptChoice>((resolve) => {
        let connection: Gio.DBusConnection;
        try {
          connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        } catch {
          resolve('unavailable');
          return;
        }
        const subscriptions: number[] = [];
        let id = 0;
        let done = false;
        const finish = (choice: PromptChoice): void => {
          if (done) return;
          done = true;
          for (const subscription of subscriptions) connection.signal_unsubscribe(subscription);
          signal.removeEventListener('abort', onAbort);
          resolve(choice);
        };
        const onAbort = (): void => {
          // The broker gave up (timeout, session over): take the notification down, then settle.
          if (id !== 0) {
            connection.call(
              NOTIFICATIONS_NAME,
              NOTIFICATIONS_PATH,
              NOTIFICATIONS_NAME,
              'CloseNotification',
              new GLib.Variant('(u)', [id]),
              null,
              Gio.DBusCallFlags.NO_AUTO_START,
              5_000,
              null,
              null,
            );
          }
          finish('dismissed');
        };
        if (signal.aborted) {
          resolve('dismissed');
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });

        // Subscribe BEFORE Notify: a fast answer must not slip past a listener not yet there.
        const listen = (name: string, handler: (params: GLib.Variant) => void): void => {
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
          const [notified, key] = params.recursiveUnpack() as [number, string];
          if (notified === id && id !== 0 && key in ACTION_CHOICES) finish(ACTION_CHOICES[key]);
        });
        listen('NotificationClosed', (params) => {
          const [notified] = params.recursiveUnpack() as [number, number];
          if (notified === id && id !== 0) finish('dismissed');
        });

        let name: string | undefined;
        try {
          name = options.nameOf?.(ask);
        } catch {
          // A name is convenience: the prompt shows the address without it.
        }
        const { summary, body } = promptText(ask, name);
        connection.call(
          NOTIFICATIONS_NAME,
          NOTIFICATIONS_PATH,
          NOTIFICATIONS_NAME,
          'Notify',
          new GLib.Variant('(susssasa{sv}i)', [
            'Curlew',
            0,
            'dialog-question-symbolic',
            summary,
            body,
            actionsFor(ask),
            {},
            ACCESS_PROMPT_TIMEOUT_MS,
          ]),
          new GLib.VariantType('(u)'),
          Gio.DBusCallFlags.NO_AUTO_START,
          10_000,
          null,
          (_source, result) => {
            try {
              id = (connection.call_finish(result!).recursiveUnpack() as [number])[0];
            } catch {
              finish('unavailable');
              return;
            }
            // The broker may have given up while Notify was in flight.
            if (signal.aborted) onAbort();
          },
        );
      }),
  };
}
