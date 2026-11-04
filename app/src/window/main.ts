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
    const window = createWindow(app);
    // A smoke hook for screenshots and CI: the process ends itself. An environment variable and
    // not a flag, because GApplication rejects options it does not know.
    const quitAfter = Number(process.env.CURLEW_WINDOW_QUIT_AFTER_MS);
    if (quitAfter > 0)
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, quitAfter, () => (app.quit(), GLib.SOURCE_REMOVE));
    return window;
  },
});
// `window` is curlew's own argument; GApplication would reject it.
const code = await runApplication(application, [system.programInvocationName]);
process.exit(code);
