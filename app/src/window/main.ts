/**
 * Entry of the window bundle (`dist/window.gjs.mjs`), loaded by `curlew window`. GTK lives only
 * here, so the CLI bundle never pulls it in.
 */

import GLib from 'gi://GLib?version=2.0';
import system from 'system';
import { AdwaitaApp, runApplication } from '@gjsify/adwaita-app';

import { initI18n } from '../core/lib/i18n.ts';
import { APP_ID, installAboutAction } from './about.ts';
import { createWindow } from './window.ts';

// This bundle carries its own copy of the gettext runtime, so the CLI bundle's catalogue is not
// the one `_()` reads here.
initI18n();

const application = new AdwaitaApp({
  applicationId: APP_ID,
  createWindow: (app) => {
    installAboutAction(app);
    // `CURLEW_WINDOW_FILTER=<backend>` starts with that protocol chip switched on, for screenshots.
    const window = createWindow(app, { protocol: process.env.CURLEW_WINDOW_FILTER || undefined });
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
    return window;
  },
});
// `window` is curlew's own argument; GApplication would reject it.
const code = await runApplication(application, [system.programInvocationName]);
process.exit(code);
