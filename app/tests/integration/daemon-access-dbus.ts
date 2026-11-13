// RequestAccess over a real session bus: client → daemon service → broker → notification prompt,
// with a fake org.freedesktop.Notifications server that answers from a script. Run under
// `dbus-run-session` (see the test:access-dbus script); the unit suite has no bus by design.
import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import { AccessBroker } from '../../src/core/access-broker.ts';
import type { AccessAsk } from '../../src/core/access.ts';
import { gioAccessClient } from '../../src/core/lib/daemon-access-client.ts';
import { gioNotificationPrompt } from '../../src/core/lib/access-notifications.ts';
import { publishDaemonSend } from '../../src/core/lib/daemon-send-service.ts';

const NOTIFICATIONS_XML = `<node>
  <interface name="org.freedesktop.Notifications">
    <method name="Notify">
      <arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/>
      <arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/>
      <arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/>
    </method>
    <method name="CloseNotification"><arg type="u" direction="in"/></method>
    <signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
    <signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
  </interface>
</node>`;

const PORTAL_XML = `<node>
  <interface name="org.freedesktop.portal.Notification">
    <method name="AddNotification"><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/></method>
    <method name="RemoveNotification"><arg type="s" direction="in"/></method>
    <signal name="ActionInvoked"><arg type="s"/><arg type="s"/><arg type="av"/></signal>
  </interface>
</node>`;

const log = (...parts: unknown[]) => console.log(parts.map((p) => String(p)).join(' '));
let failures = 0;
const check = (name: string, ok: boolean): void => {
  log(ok ? 'ok  ' : 'FAIL', name);
  if (!ok) failures += 1;
};

async function main(): Promise<void> {
  const conn = Gio.bus_get_sync(Gio.BusType.SESSION, null);

  // The fake notification server: answers each Notify with the next scripted action key.
  const script: string[] = [];
  const shown: Array<{ summary: string; body: string; actions: string[] }> = [];
  let nextId = 1;
  const iface = Gio.DBusNodeInfo.new_for_xml(NOTIFICATIONS_XML).lookup_interface(
    'org.freedesktop.Notifications',
  );
  if (!iface) throw new Error('no notifications interface');
  conn.register_object(
    '/org/freedesktop/Notifications',
    iface,
    ((
      _c: unknown,
      _s: string,
      _p: string,
      _i: string,
      method: string,
      params: GLib.Variant,
      inv: Gio.DBusMethodInvocation,
    ) => {
      if (method !== 'Notify') {
        inv.return_value(null);
        return;
      }
      const [, , , summary, body, actions] = params.recursiveUnpack() as [
        string,
        number,
        string,
        string,
        string,
        string[],
      ];
      const id = nextId++;
      shown.push({ summary, body, actions });
      inv.return_value(new GLib.Variant('(u)', [id]));
      const key = script.shift();
      if (key !== undefined) {
        setTimeout(() => {
          conn.emit_signal(
            null,
            '/org/freedesktop/Notifications',
            'org.freedesktop.Notifications',
            'ActionInvoked',
            new GLib.Variant('(us)', [id, key]),
          );
          conn.emit_signal(
            null,
            '/org/freedesktop/Notifications',
            'org.freedesktop.Notifications',
            'NotificationClosed',
            new GLib.Variant('(uu)', [id, 3]),
          );
        }, 30);
      }
    }) as unknown as Parameters<Gio.DBusConnection['register_object']>[2],
    null,
    null,
  );
  Gio.bus_own_name_on_connection(
    conn,
    'org.freedesktop.Notifications',
    Gio.BusNameOwnerFlags.NONE,
    null,
    null,
  );

  const rules: AccessAsk[] = [];
  const broker = new AccessBroker({
    ui: gioNotificationPrompt(),
    policy: () => ({ askWithoutRule: true, rules: [] }),
    addRule: (ask) => void rules.push(ask),
    timeoutMs: 400,
  });
  const service = publishDaemonSend(async () => ({ v: 1, kind: 'not-followed' }), {
    log: (line) => log('daemon:', line),
    access: (request) => broker.request(request),
    onSessionEnd: (session) => broker.endSession(session),
  });
  if (!service) throw new Error('no service');
  await new Promise<void>((resolve) => setTimeout(resolve, 300));

  const client = gioAccessClient();
  const ask = (over: Partial<AccessAsk> = {}): Promise<unknown> =>
    client.request({
      account: 'xmpp-abc123',
      contact: 'friend@example.org',
      kind: 'write',
      session: 'mcp-1',
      oneShot: false,
      preview: 'hello',
      ...over,
    });
  const said = async (over: Partial<AccessAsk> = {}): Promise<string> => JSON.stringify(await ask(over));

  script.push('once');
  check('once is allowed', (await said()) === '{"allowed":true,"reason":"once"}');
  check(
    'the prompt names the recipient and offers four actions',
    shown[0].body.includes('friend@example.org') && shown[0].actions.length === 8,
  );

  script.push('session');
  check('session is allowed', (await said()) === '{"allowed":true,"reason":"session"}');
  const before = shown.length;
  check(
    'the session grant answers without a prompt',
    (await said()) === '{"allowed":true,"reason":"temporary"}' && shown.length === before,
  );

  script.push('always');
  check(
    'always adds a rule',
    (await said({ contact: 'other@example.org' })) === '{"allowed":true,"reason":"rule"}' &&
      rules.length === 1,
  );

  script.push('deny');
  check('deny is refused', (await said({ kind: 'read' })) === '{"allowed":false,"reason":"denied"}');
  const afterDeny = shown.length;
  check(
    'the same session is not asked again',
    (await said({ kind: 'read' })) === '{"allowed":false,"reason":"denied-before"}' &&
      shown.length === afterDeny,
  );

  check(
    'a one-shot prompt does not offer "for this session"',
    (script.push('once'), (await said({ oneShot: true, contact: 'x@example.org' })) !== '') &&
      shown[shown.length - 1].actions.length === 6,
  );

  check(
    'no answer is a timeout',
    (await said({ contact: 'silent@example.org' })) === '{"allowed":false,"reason":"timeout"}',
  );

  // The same prompt through the Notification portal (the path inside a sandbox), with a fake portal.
  const portalShown: Array<{ id: string; title: string; buttons: string[] }> = [];
  const portalScript: string[] = [];
  const portalIface = Gio.DBusNodeInfo.new_for_xml(PORTAL_XML).lookup_interface(
    'org.freedesktop.portal.Notification',
  );
  if (!portalIface) throw new Error('no portal interface');
  conn.register_object(
    '/org/freedesktop/portal/desktop',
    portalIface,
    ((
      _c: unknown,
      _s: string,
      _p: string,
      _i: string,
      method: string,
      params: GLib.Variant,
      inv: Gio.DBusMethodInvocation,
    ) => {
      inv.return_value(null);
      if (method !== 'AddNotification') return;
      const [id, vardict] = params.recursiveUnpack() as [
        string,
        { title: string; buttons: Array<{ action: string; label: string }> },
      ];
      const buttons = vardict.buttons.map((button) => `${button.action}=${button.label}`);
      portalShown.push({ id, title: vardict.title, buttons });
      const key = portalScript.shift();
      if (key !== undefined) {
        setTimeout(() => {
          conn.emit_signal(
            null,
            '/org/freedesktop/portal/desktop',
            'org.freedesktop.portal.Notification',
            'ActionInvoked',
            new GLib.Variant('(ssav)', [id, key, []]),
          );
        }, 30);
      }
    }) as unknown as Parameters<Gio.DBusConnection['register_object']>[2],
    null,
    null,
  );
  Gio.bus_own_name_on_connection(
    conn,
    'org.freedesktop.portal.Desktop',
    Gio.BusNameOwnerFlags.NONE,
    null,
    null,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 200));

  const portalBroker = new AccessBroker({
    ui: gioNotificationPrompt({ portal: true }),
    policy: () => ({ askWithoutRule: true, rules: [] }),
    addRule: () => undefined,
    timeoutMs: 400,
  });
  const portalAsk = (over: Partial<AccessAsk> = {}) =>
    portalBroker.request({
      account: 'xmpp-abc123',
      contact: 'friend@example.org',
      kind: 'write',
      session: 'mcp-2',
      oneShot: false,
      preview: 'hello',
      ...over,
    });
  portalScript.push('once');
  check('portal: once is allowed', JSON.stringify(await portalAsk()) === '{"allowed":true,"reason":"once"}');
  check(
    'portal: four buttons, plain action names',
    portalShown[0].buttons.join('|') === 'once=Allow once|session=For this session|always=Always|deny=Deny',
  );
  portalScript.push('deny');
  check(
    'portal: deny is refused',
    JSON.stringify(await portalAsk({ kind: 'read', contact: 'b@example.org' })) ===
      '{"allowed":false,"reason":"denied"}',
  );
  check(
    'portal: a one-shot prompt has three buttons',
    (portalScript.push('once'), await portalAsk({ oneShot: true, contact: 'c@example.org' })) !== null &&
      portalShown[portalShown.length - 1].buttons.length === 3,
  );
  check(
    'portal: no answer is a timeout',
    JSON.stringify(await portalAsk({ contact: 'silent@example.org' })) ===
      '{"allowed":false,"reason":"timeout"}',
  );

  service.close();
  check('after the daemon is gone there is nobody to ask', (await ask()) === null);
}

const runningOnGjs = typeof (globalThis as { imports?: unknown }).imports !== 'undefined';
const done = main().then(
  () => log(failures === 0 ? 'OK' : `FAILED: ${failures}`),
  (error) => {
    failures += 1;
    log('FAILED:', String(error));
  },
);
const finish = (): never => process.exit(failures === 0 ? 0 : 1) as never;
if (runningOnGjs) {
  const loop = new GLib.MainLoop(null, false);
  done.then(finish);
  loop.run();
} else {
  done.then(finish);
}
