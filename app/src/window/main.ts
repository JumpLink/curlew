/**
 * Entry of the window bundle (`dist/window.gjs.mjs`), loaded by `curlew window`. GTK lives only
 * here, so the CLI bundle never pulls it in.
 */

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import system from 'system';
import { AdwaitaApp, runApplication } from '@gjsify/adwaita-app';

import { initI18n } from '../core/lib/i18n.ts';
import { APP_ID, installAboutAction } from './about.ts';
import { configPath } from '@curlew/store';
import { loadConfig } from '../core/config.ts';
import { applyAccent, applyColorScheme, applyPrimary, installSurfaces } from './appearance.ts';
import { applyChatBackground } from './chat-background.ts';
import { demoActive, prepareDemo } from '../core/demo/index.ts';
import { startStallProbe } from './stall-probe.ts';
import { createWindow } from './window.ts';

// This bundle carries its own copy of the gettext runtime, so the CLI bundle's catalogue is not
// the one `_()` reads here.
initI18n();

// `CURLEW_DEMO=1`: made-up data in a scratch directory, set up before anything reads the index or
// the config.
if (demoActive()) prepareDemo();
startStallProbe();

// Wayland matches the window to its icon through the application id, but X11 and anything that
// cannot read it need the name spelled out.
Gtk.Window.set_default_icon_name(APP_ID);

// An installed curlew finds its icon in the hicolor theme. A run from the source tree has none
// installed, so the window, the About dialog and the shell all fell back to a generic icon:
// <app>/dist/window.gjs.mjs → <app>/data/icons and <app>/data/protocol-icons.
function addSourceTreeIcons(): void {
  const display = Gdk.Display.get_default();
  if (!display || !import.meta.url.startsWith('file:')) return;
  const bundleDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
  // The protocol badges live apart from the app icon: `gjsify ship` reads every SVG under
  // `gjsify.ship.icon` as the app's own icon, and ships the badges through `extraFiles` instead.
  for (const dir of ['icons', 'protocol-icons']) {
    const icons = GLib.build_filenamev([bundleDir, '..', 'data', dir]);
    if (GLib.file_test(icons, GLib.FileTest.IS_DIR))
      Gtk.IconTheme.get_for_display(display).add_search_path(icons);
  }
}

const application = new AdwaitaApp({
  applicationId: APP_ID,
  createWindow: (app) => {
    addSourceTreeIcons();
    installSurfaces();
    // A broken config must not stop the window from opening: it keeps Curlew's own accent.
    try {
      const ui = loadConfig(configPath()).ui;
      applyColorScheme(ui.colorScheme);
      applyPrimary(ui.primaryColor);
      applyAccent(ui.accentColor);
      applyChatBackground(ui.chatBackground);
    } catch {
      applyPrimary(undefined);
      applyAccent(undefined);
      applyChatBackground(undefined);
    }
    installAboutAction(app);
    // `CURLEW_WINDOW_FILTER=<backend>` starts with that protocol filter switched on, and
    // `CURLEW_WINDOW_OPEN=<conversation id>` with that conversation open, for screenshots.
    const window = createWindow(app, {
      protocol: process.env.CURLEW_WINDOW_FILTER || undefined,
      open: process.env.CURLEW_WINDOW_OPEN || undefined,
      search: process.env.CURLEW_WINDOW_SEARCH || undefined,
      openScope: process.env.CURLEW_WINDOW_OPEN_SCOPE === '1',
    });
    // A notification opens a chat over the bus: `app.open-conversation` hands the id to the window.
    const open = new Gio.SimpleAction({
      name: 'open-conversation',
      parameterType: GLib.VariantType.new('s'),
    });
    open.connect('activate', (_a, parameter) => window.activate_action('open-conversation', parameter));
    app.add_action(open);
    // A smoke hook for screenshots and CI: the process ends itself. An environment variable and
    // not a flag, because GApplication rejects options it does not know.
    const quitAfter = Number(process.env.CURLEW_WINDOW_QUIT_AFTER_MS);
    if (quitAfter > 0)
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, quitAfter, () => (app.quit(), GLib.SOURCE_REMOVE));
    // Likewise for a narrow screenshot: `WIDTHxHEIGHT`, which the monitor would otherwise cap.
    const size = /^(\d+)x(\d+)$/.exec(process.env.CURLEW_WINDOW_SIZE ?? '');
    if (size) window.set_default_size(Number(size[1]), Number(size[2]));
    // Likewise for the dialog screenshot: opens it as soon as the window is up.
    if (process.env.CURLEW_WINDOW_OPEN_ACCESS === '1')
      GLib.idle_add(
        GLib.PRIORITY_DEFAULT,
        () => (window.activate_action('agent-access', null), GLib.SOURCE_REMOVE),
      );
    if (process.env.CURLEW_WINDOW_OPEN_CONTACT === '1')
      GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        1500,
        () => (window.activate_action('open-contact', null), GLib.SOURCE_REMOVE),
      );
    // Likewise for the composer's emoji chooser, after the conversation has been built.
    if (process.env.CURLEW_WINDOW_OPEN_EMOJI === '1')
      GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        2000,
        () => (window.activate_action('open-emoji', null), GLib.SOURCE_REMOVE),
      );
    if (process.env.CURLEW_WINDOW_OPEN_ACCOUNTS === '1')
      GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        1000,
        () => (window.activate_action('accounts', null), GLib.SOURCE_REMOVE),
      );
    if (process.env.CURLEW_WINDOW_OPEN_PROTOCOLS === '1')
      GLib.idle_add(
        GLib.PRIORITY_DEFAULT,
        () => (window.activate_action('protocols', null), GLib.SOURCE_REMOVE),
      );
    if (process.env.CURLEW_WINDOW_OPEN_PREFERENCES === '1')
      GLib.idle_add(
        GLib.PRIORITY_DEFAULT,
        () => (window.activate_action('preferences', null), GLib.SOURCE_REMOVE),
      );
    // `CURLEW_WINDOW_OPEN_WELCOME=1` opens the first-run welcome screen, `=<page id>` that page.
    const welcomeAt = process.env.CURLEW_WINDOW_OPEN_WELCOME;
    if (welcomeAt)
      GLib.idle_add(
        GLib.PRIORITY_DEFAULT,
        () => (
          window.activate_action('welcome-page', GLib.Variant.new_string(welcomeAt)),
          GLib.SOURCE_REMOVE
        ),
      );
    return window;
  },
});
// `window` is curlew's own argument; GApplication would reject it.
const code = await runApplication(application, [system.programInvocationName]);
process.exit(code);
