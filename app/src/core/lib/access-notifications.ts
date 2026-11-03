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

const NOTIFICATIONS_NAME = 'org.freedesktop.Notifications';
const NOTIFICATIONS_PATH = '/org/freedesktop/Notifications';

/** The action keys on the wire; `deny` is a button of its own, not just a closed notification. */
const ACTION_CHOICES: Record<string, PromptChoice> = {
  once: 'once',
  session: 'session',
  always: 'always',
  deny: 'deny',
};

/** What the notification says, in the person's language. Exported for the tests. */
export function promptText(ask: AccessAsk): { summary: string; body: string } {
  const target = ask.contact === undefined ? ask.account : ask.contact;
  const values = { contact: target, account: ask.account, preview: ask.preview ?? '' };
  if (ask.kind === 'write') {
    return {
      summary: _('An agent wants to send a message'),
      body:
        ask.preview === undefined
          ? fmt(_('To {contact} ({account}).'), values)
          : fmt(_('To {contact} ({account}): “{preview}”'), values),
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

/** The prompt as a notification on the session bus; no bus or no notification service is `unavailable`. */
export function gioNotificationPrompt(): PromptUi {
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

        const { summary, body } = promptText(ask);
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
