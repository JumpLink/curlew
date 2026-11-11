// The Background portal driver over a real session bus, against a fake portal that answers
// through the Request object like the real one. Run under `dbus-run-session` (see the
// test:autostart-dbus script); the unit suite has no bus by design.
import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import { portalAutostart } from '../../src/core/lib/autostart-portal.ts';

const XML = `<node>
  <interface name="org.freedesktop.portal.Background">
    <method name="RequestBackground"><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
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
  const calls: Array<Record<string, unknown>> = [];
  let answer = 0;
  const iface = Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0];
  conn.register_object(
    '/org/freedesktop/portal/desktop',
    iface,
    ((
      _c: unknown,
      sender: string,
      _p: string,
      _i: string,
      _m: string,
      params: GLib.Variant,
      inv: Gio.DBusMethodInvocation,
    ) => {
      const [, options] = params.recursiveUnpack() as [string, Record<string, unknown>];
      calls.push(options);
      const path = `/org/freedesktop/portal/desktop/request/${sender.replace(/^:/, '').replace(/\./g, '_')}/${options.handle_token}`;
      inv.return_value(new GLib.Variant('(o)', [path]));
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        conn.emit_signal(
          null,
          path,
          'org.freedesktop.portal.Request',
          'Response',
          new GLib.Variant('(ua{sv})', [
            answer,
            { autostart: new GLib.Variant('b', options.autostart === true) },
          ]),
        );
        return GLib.SOURCE_REMOVE;
      });
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
  await new Promise<void>((resolve) => setTimeout(resolve, 300));

  const autostart = portalAutostart({ commandline: ['curlew', 'daemon'], reason: 'Keep receiving' });
  check('the portal cannot be asked, so the status is unknown', (await autostart.status()) === 'unknown');
  check('it needs no unit file', autostart.needsUnitFile === false);

  const on = await autostart.enable();
  check('an allowed request enables', on.ok === true);
  check(
    'the request names the command and asks for autostart',
    calls[0]?.autostart === true && String(calls[0]?.commandline) === 'curlew,daemon',
  );
  const off = await autostart.disable();
  check('disable asks the portal to stop autostarting', off.ok === true && calls[1]?.autostart === false);

  answer = 1;
  const declined = await autostart.enable();
  check('a declined dialog is a refusal with a reason', declined.ok === false && declined.reason.length > 0);
}

const done = main().then(
  () => undefined,
  (error) => {
    failures += 1;
    log('FAILED:', String(error));
  },
);
const loop = new GLib.MainLoop(null, false);
done.then(() => {
  log(failures === 0 ? 'ALL OK' : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
loop.run();
