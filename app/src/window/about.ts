/**
 * The About dialog, opened from the header menu (`app.about`).
 *
 * The link is labelled "Support", never "Donate": this is business income, and nothing here may imply
 * a tax deduction. The URL is the one in `<url type="donation">` of the metainfo.
 */

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { donationsAllowed } from '@gjsify/distribution';
import { _ } from '@curlew/protocol';

import { VERSION } from '../core/version.ts';

export const APP_ID = 'eu.jumplink.curlew';

export const WEBSITE = 'https://jumplink.eu/curlew/';
export const SUPPORT_URL = `${WEBSITE}en/support/`;
export const REPOSITORY = 'https://github.com/JumpLink/curlew';

/** The site language for the person's UI: the first preferred language the site has pages in, else English. */
export function siteLanguage(candidates: readonly string[]): 'en' | 'de' {
  for (const raw of candidates) {
    const language = raw.split(/[._@:-]/)[0]?.toLowerCase();
    if (language === 'de' || language === 'en') return language;
  }
  return 'en';
}

export function installAboutAction(app: Adw.Application): void {
  const action = new Gio.SimpleAction({ name: 'about' });
  action.connect('activate', () => {
    const lang = siteLanguage(GLib.get_language_names());
    const dialog = new Adw.AboutDialog({
      applicationName: _('Curlew'),
      applicationIcon: APP_ID,
      version: VERSION,
      developerName: 'Pascal Garber',
      developers: ['JumpLink (Pascal Garber) https://github.com/JumpLink'],
      copyright: _('© 2026 Pascal Garber'),
      comments: _('Chats across messengers'),
      website: WEBSITE,
      issueUrl: `${REPOSITORY}/issues`,
      licenseType: Gtk.License.AGPL_3_0,
    });
    if (donationsAllowed()) dialog.add_link(_('Support'), SUPPORT_URL);
    dialog.add_link(_('Source code'), REPOSITORY);
    dialog.add_link(_('Privacy'), `${WEBSITE}${lang}/privacy/`);
    dialog.add_link(_('Legal notice'), `${WEBSITE}${lang}/legal-notice/`);
    dialog.present(app.get_active_window());
  });
  app.add_action(action);
}
