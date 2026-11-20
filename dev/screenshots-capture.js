// dev/screenshots-capture.js <out.png> -- one monitor frame inside a headless-run session.
// headless-run's window-shot.js asks for 15 frames; the stream is damage driven, so on a still screen
// that waits out its 15 s timeout on every capture. One buffer arrives at once; the caller compares two
// captures to know the frame is stable, so the "first frame may predate the paint" caveat does not apply.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function capture(out) {
    const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
    const call = (path, iface, method, params, type) =>
        bus.call_sync('org.gnome.Mutter.ScreenCast', path, iface, method, params,
            GLib.VariantType.new(type), Gio.DBusCallFlags.NONE, 10000, null);
    const session = call('/org/gnome/Mutter/ScreenCast', 'org.gnome.Mutter.ScreenCast', 'CreateSession',
        new GLib.Variant('(a{sv})', [{}]), '(o)').deepUnpack()[0];
    const stream = call(session, 'org.gnome.Mutter.ScreenCast.Session', 'RecordMonitor',
        new GLib.Variant('(sa{sv})', ['Meta-0', {}]), '(o)').deepUnpack()[0];
    const loop = GLib.MainLoop.new(null, false);
    let node = null;
    bus.signal_subscribe('org.gnome.Mutter.ScreenCast', 'org.gnome.Mutter.ScreenCast.Stream',
        'PipeWireStreamAdded', stream, null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
            node = params.deepUnpack()[0];
            loop.quit();
        });
    call(session, 'org.gnome.Mutter.ScreenCast.Session', 'Start', null, '()');
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => (loop.quit(), GLib.SOURCE_REMOVE));
    loop.run();
    if (node === null) {
        printerr('window-shot: no PipeWire stream appeared');
        imports.system.exit(1);
    }
    const gst = Gio.Subprocess.new(['timeout', '6', 'gst-launch-1.0', '-q', 'pipewiresrc', `path=${node}`,
        'num-buffers=1', '!', 'videoconvert', '!', 'pngenc', 'snapshot=false', '!', 'multifilesink',
        `location=${out}.%d.png`], Gio.SubprocessFlags.NONE);
    gst.wait(null);
    call(session, 'org.gnome.Mutter.ScreenCast.Session', 'Stop', null, '()');
    let last = -1;
    for (let i = 0; i < 1 && GLib.file_test(`${out}.${i}.png`, GLib.FileTest.EXISTS); i++) last = i;
    if (last < 0) {
        printerr('window-shot: gstreamer wrote no frame');
        imports.system.exit(1);
    }
    Gio.File.new_for_path(`${out}.${last}.png`).move(Gio.File.new_for_path(out), Gio.FileCopyFlags.OVERWRITE, null, null);
    for (let i = 0; i < 1; i++) GLib.unlink(`${out}.${i}.png`);
}

capture(ARGV[0]);
