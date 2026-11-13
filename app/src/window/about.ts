/** The About dialog, opened from the header menu (`app.about`). */

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';

import { VERSION } from '../core/version.ts';

export const APP_ID = 'eu.jumplink.curlew';

export function installAboutAction(app: Adw.Application): void {
  const action = new Gio.SimpleAction({ name: 'about' });
  action.connect('activate', () => {
    const dialog = new Adw.AboutDialog({
      applicationName: _('Curlew'),
      applicationIcon: APP_ID,
      version: VERSION,
      developerName: 'Pascal Garber',
      developers: ['JumpLink (Pascal Garber) https://github.com/JumpLink'],
      copyright: _('© 2026 Pascal Garber'),
      comments: _('Chats across messengers'),
      website: 'https://github.com/JumpLink/curlew',
      issueUrl: 'https://github.com/JumpLink/curlew/issues',
      licenseType: Gtk.License.AGPL_3_0,
    });
    dialog.present(app.get_active_window());
  });
  app.add_action(action);
}
