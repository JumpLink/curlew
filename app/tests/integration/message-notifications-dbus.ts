// The daemon's message notifications over a real session bus: the desktop's notification service
// (a fake one here) → a click → the window's `open-conversation` action (a fake one too), then the
// same inside a sandbox, where the Notification portal (fake) takes the notices. Run under `dbus-run-session` (see the test:notifications-dbus script); the unit
// suite has no bus by design.
import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import { gioNoticeSink } from '../../src/core/lib/message-notifications.ts';

const NOTIFICATIONS_XML = `<node>
  <interface name="org.freedesktop.Notifications">
    <method name="Notify">
      <arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/>
      <arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/>
      <arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/>
    </method>
    <method name="CloseNotification"><arg type="u" direction="in"/></method>
    <method name="GetCapabilities"><arg type="as" direction="out"/></method>
    <method name="GetServerInformation">
      <arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/>
    </method>
    <signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
  </interface>
</node>`;

const APPLICATION_XML = `<node>
  <interface name="org.freedesktop.Application">
    <method name="ActivateAction">
      <arg type="s" direction="in"/><arg type="av" direction="in"/><arg type="a{sv}" direction="in"/>
    </method>
  </interface>
</node>`;

const PORTAL_XML = `<node>
  <interface name="org.freedesktop.portal.Notification">
    <method name="AddNotification"><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/></method>
  </interface>
</node>`;

const log = (...parts: unknown[]) => console.log(parts.map((p) => String(p)).join(' '));
let failures = 0;
const check = (name: string, ok: boolean): void => {
  log(ok ? 'ok  ' : 'FAIL', name);
  if (!ok) failures += 1;
};
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Handler = (method: string, params: GLib.Variant, inv: Gio.DBusMethodInvocation) => void;

function serve(conn: Gio.DBusConnection, path: string, xml: string, name: string, handler: Handler): void {
  const iface = Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0];
  conn.register_object(
    path,
    iface,
    ((
      _c: unknown,
      _s: string,
      _p: string,
      _i: string,
      method: string,
      params: GLib.Variant,
      inv: Gio.DBusMethodInvocation,
    ) => handler(method, params, inv)) as unknown as Parameters<Gio.DBusConnection['register_object']>[2],
    null,
    null,
  );
  Gio.bus_own_name_on_connection(conn, name, Gio.BusNameOwnerFlags.NONE, null, null);
}

async function main(): Promise<void> {
  const conn = Gio.bus_get_sync(Gio.BusType.SESSION, null);

  const shown: Array<{
    replaces: number;
    summary: string;
    body: string;
    actions: string[];
    hints: Record<string, unknown>;
  }> = [];
  let nextId = 10;
  serve(
    conn,
    '/org/freedesktop/Notifications',
    NOTIFICATIONS_XML,
    'org.freedesktop.Notifications',
    (method, params, inv) => {
      if (method === 'Notify') {
        const [, replaces, , summary, body, actions, hints] = params.recursiveUnpack() as [
          string,
          number,
          string,
          string,
          string,
          string[],
          Record<string, unknown>,
        ];
        shown.push({ replaces, summary, body, actions, hints });
        inv.return_value(new GLib.Variant('(u)', [replaces || nextId++]));
      } else if (method === 'GetCapabilities') {
        inv.return_value(new GLib.Variant('(as)', [['actions', 'body']]));
      } else if (method === 'GetServerInformation') {
        inv.return_value(new GLib.Variant('(ssss)', ['fake', 'example.org', '1', '1.2']));
      } else {
        inv.return_value(null);
      }
    },
  );

  const activated: Array<{ action: string; target: string }> = [];
  serve(conn, '/eu/jumplink/curlew', APPLICATION_XML, 'eu.jumplink.curlew', (method, params, inv) => {
    if (method === 'ActivateAction') {
      const [action, args] = params.recursiveUnpack() as [string, string[]];
      activated.push({ action, target: args[0] });
    }
    inv.return_value(null);
  });
  await wait(300);

  const sink = gioNoticeSink();
  sink.show({ conversationId: 'c-one', title: 'Alex Weber', body: 'Hello', messageId: 'm1' });
  await wait(300);
  check('a notice reaches the notification service', shown.length === 1 && shown[0].summary === 'Alex Weber');
  check('the body travels', shown[0]?.body === 'Hello');
  check('the notification offers a default action', shown[0]?.actions.includes('default') === true);
  check(
    'the desktop entry names the application',
    String(shown[0]?.hints['desktop-entry']) === 'eu.jumplink.curlew',
  );

  sink.show({ conversationId: 'c-one', title: 'Alex Weber', body: 'Hello again', messageId: 'm2' });
  await wait(300);
  check(
    'a second notice of the same chat replaces the first',
    shown.length === 2 && shown[1].replaces === 10,
  );

  sink.show({ conversationId: 'c-two', title: 'GNOME Design', body: 'Hi', messageId: 'm3' });
  await wait(300);
  check('another chat is another notification', shown.length === 3 && shown[2].replaces === 0);

  conn.emit_signal(
    null,
    '/org/freedesktop/Notifications',
    'org.freedesktop.Notifications',
    'ActionInvoked',
    new GLib.Variant('(us)', [10, 'default']),
  );
  await wait(500);
  check(
    'a click opens that chat in the window',
    activated.length === 1 && activated[0].action === 'open-conversation' && activated[0].target === 'c-one',
  );

  sink.close();

  const added: Array<{ id: string; title: string; action: string; target: string; category: string }> = [];
  serve(
    conn,
    '/org/freedesktop/portal/desktop',
    PORTAL_XML,
    'org.freedesktop.portal.Desktop',
    (method, params, inv) => {
      if (method === 'AddNotification') {
        const [id, detail] = params.recursiveUnpack() as [string, Record<string, unknown>];
        added.push({
          id,
          title: String(detail.title),
          action: String(detail['default-action']),
          target: String(detail['default-action-target']),
          category: String(detail.category),
        });
      }
      inv.return_value(null);
    },
  );
  await wait(300);
  GLib.setenv('FLATPAK_ID', 'eu.jumplink.curlew', true);
  const before = shown.length;
  const sandboxed = gioNoticeSink();
  sandboxed.show({ conversationId: 'c-one', title: 'Alex Weber', body: 'Hello', messageId: 'm4' });
  await wait(300);
  check('in a sandbox the portal takes the notice', added.length === 1 && added[0].title === 'Alex Weber');
  check('the portal id is the chat, so a later notice replaces it', added[0]?.id === 'c-one');
  check(
    'the portal click names the action and the chat',
    added[0]?.action === 'open-conversation' &&
      added[0]?.target === 'c-one' &&
      added[0]?.category === 'im.received',
  );
  check('the desktop service is not used in a sandbox', shown.length === before);
  sandboxed.close();
  log(failures === 0 ? 'ALL OK' : `${failures} FAILED`);
  if (failures > 0) throw new Error('notifications-dbus failed');
}

const done = main().then(
  () => undefined,
  (error) => {
    failures += 1;
    log('FAILED:', String(error));
  },
);
const loop = new GLib.MainLoop(null, false);
done.then(() => process.exit(failures === 0 ? 0 : 1));
loop.run();
