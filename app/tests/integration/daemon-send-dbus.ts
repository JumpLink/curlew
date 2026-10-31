// Spike: raw Gio.DBusConnection.register_object + bus_own_name_on_connection on GJS and node-gi.
import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';

const XML = `<node>
  <interface name="eu.jumplink.curlew.Spike1">
    <method name="Echo">
      <arg type="s" name="request" direction="in"/>
      <arg type="s" name="reply" direction="out"/>
    </method>
  </interface>
</node>`;

const log = (...parts: unknown[]) => console.log(parts.map((p) => String(p)).join(' '));

async function main(): Promise<void> {
  const conn = Gio.bus_get_sync(Gio.BusType.SESSION, null);
  log('connection:', conn.get_unique_name());

  const node = Gio.DBusNodeInfo.new_for_xml(XML);
  const iface = node.lookup_interface('eu.jumplink.curlew.Spike1');
  if (!iface) throw new Error('no iface info');

  let registered = 0;
  try {
    registered = conn.register_object(
      '/eu/jumplink/curlew/Spike',
      iface,
      // deno-lint-ignore no-explicit-any
      ((
        _c: Gio.DBusConnection,
        _sender: string,
        _path: string,
        _ifaceName: string,
        method: string,
        params: GLib.Variant,
        invocation: Gio.DBusMethodInvocation,
      ) => {
        log('method call:', method, params.print(true));
        const [request] = params.recursiveUnpack() as [string];
        invocation.return_value(new GLib.Variant('(s)', [`echo:${request}`]));
      }) as unknown as Parameters<Gio.DBusConnection['register_object']>[2],
      null,
      null,
    );
  } catch (error) {
    log('register_object THREW:', String(error));
    return;
  }
  log('registered id:', registered);

  const ownerId = Gio.bus_own_name_on_connection(
    conn,
    'eu.jumplink.curlew.Spike',
    Gio.BusNameOwnerFlags.NONE,
    (() => log('name acquired')) as unknown as Parameters<typeof Gio.bus_own_name_on_connection>[3],
    (() => log('name lost')) as unknown as Parameters<typeof Gio.bus_own_name_on_connection>[4],
  );
  log('owner id:', ownerId);

  // Give the bus a moment to deliver the name-acquired signal.
  await new Promise<void>((resolve) => setTimeout(resolve, 300));

  const reply = await new Promise<string>((resolve, reject) => {
    conn.call(
      'eu.jumplink.curlew.Spike',
      '/eu/jumplink/curlew/Spike',
      'eu.jumplink.curlew.Spike1',
      'Echo',
      new GLib.Variant('(s)', ['hello']),
      new GLib.VariantType('(s)'),
      Gio.DBusCallFlags.NONE,
      5000,
      null,
      (_src, res) => {
        try {
          const out = conn.call_finish(res!);
          resolve((out.recursiveUnpack() as [string])[0]);
        } catch (error) {
          reject(error as Error);
        }
      },
    );
  });
  log('CALL REPLY:', reply);

  Gio.bus_unown_name(ownerId);
  conn.unregister_object(registered);
  log('OK');
}

const runningOnGjs = typeof (globalThis as { imports?: unknown }).imports !== 'undefined';

const done = main().then(
  () => log('done'),
  (error) => log('FAILED:', String(error)),
);

if (runningOnGjs) {
  const loop = new GLib.MainLoop(null, false);
  done.then(() => process.exit(0));
  loop.run();
} else {
  done.then(() => process.exit(0));
}
