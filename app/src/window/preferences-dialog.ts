/** App-wide presentation settings; agent permissions stay in their own dialog. */

import Adw from 'gi://Adw?version=1';
import type Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';
import { configPath } from '@curlew/store';

import { loadConfig, saveConfig } from '../core/config.ts';

export function presentPreferences(parent: Gtk.Window | null, onChanged: () => void): void {
  const path = configPath();
  const overlay = new Adw.ToastOverlay();
  const row = new Adw.SwitchRow({
    title: _('Show all emails'),
    subtitle: _('Show ordinary email threads beside conversations started by a chat messenger'),
    active: loadConfig(path).ui.showAllEmails,
  });
  const group = new Adw.PreferencesGroup({ title: _('Conversations') });
  group.add(row);
  const page = new Adw.PreferencesPage();
  page.add(group);
  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(new Adw.HeaderBar());
  toolbar.set_content(page);
  overlay.set_child(toolbar);
  const dialog = new Adw.Dialog({ title: _('Preferences'), contentWidth: 520, contentHeight: 360 });
  dialog.set_child(overlay);

  row.connect('notify::active', () => {
    try {
      const config = loadConfig(path);
      config.ui.showAllEmails = row.get_active();
      saveConfig(config, path);
      onChanged();
    } catch (err) {
      overlay.add_toast(new Adw.Toast({ title: err instanceof Error ? err.message : String(err), timeout: 6 }));
    }
  });
  dialog.present(parent);
}
