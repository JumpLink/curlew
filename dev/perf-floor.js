// What an EMPTY window costs here: the floor the environment itself imposes, measured with the
// same 16 ms tick the app's stall probe uses (app/src/window/stall-probe.ts).
//
// WHY THE HARNESS NEEDS IT. A main-loop block is not evidence about Curlew unless the renderer
// underneath can keep up. In a container there is no GPU, GTK falls back to llvmpipe, and a bare
// `Adw.ApplicationWindow` with a status page in it blocks the loop for ~500 ms on its first frame
// -- ten times the budget, with no Curlew code in the process at all. So `dev/perf-report.mjs`
// runs this first and holds raw blocks against the app only where this comes in under budget; the
// work the app names with `timed()` is judged everywhere, because that is the app's own.
//
// Plain GJS on purpose: no bundle, no build step, nothing of Curlew's in it.
imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Adw = '1';
const { GLib, Adw } = imports.gi;

const TICK_MS = 16;
const THRESHOLD_MS = Number(GLib.getenv('CURLEW_DEBUG_STALL_MS') || '50');
const LIFE_MS = Number(GLib.getenv('CURLEW_WINDOW_QUIT_AFTER_MS') || '6000');
const ORIGIN = GLib.get_monotonic_time();
const sinceStart = () => (GLib.get_monotonic_time() - ORIGIN) / 1000;

let last = sinceStart();
GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
  const now = sinceStart();
  const late = now - last - TICK_MS;
  if (late > THRESHOLD_MS)
    print(`[stall] main loop blocked ${late.toFixed(0)} ms at ${(last + TICK_MS).toFixed(0)}`);
  last = now;
  return GLib.SOURCE_CONTINUE;
});

const app = new Adw.Application({ applicationId: 'eu.jumplink.curlew.PerfFloor' });
app.connect('activate', () => {
  const size = (GLib.getenv('CURLEW_WINDOW_SIZE') || '900x640').split('x');
  const win = new Adw.ApplicationWindow({
    application: app,
    defaultWidth: Number(size[0]) || 900,
    defaultHeight: Number(size[1]) || 640,
  });
  win.set_content(
    new Adw.ToolbarView({
      content: new Adw.StatusPage({ title: 'floor', description: 'an empty window, nothing else' }),
    }),
  );
  win.connect('map', () => print(`curlew window: shown at ${sinceStart().toFixed(0)}`));
  win.present();
  // The counterpart of the app's own milestone: the first frame of an empty window. Everything
  // after it is this environment idling, which is what makes the number comparable.
  const clock = win.get_frame_clock();
  const ready = () => print(`curlew window: ready at ${sinceStart().toFixed(0)}`);
  if (clock) {
    const painted = clock.connect('after-paint', () => {
      clock.disconnect(painted);
      ready();
    });
    win.queue_draw();
  } else {
    ready();
  }
  last = sinceStart();
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, LIFE_MS, () => {
    app.quit();
    return GLib.SOURCE_REMOVE;
  });
});
app.run([]);
