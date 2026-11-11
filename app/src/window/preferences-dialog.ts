/** App-wide presentation settings; agent permissions stay in their own dialog. */

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';
import { configPath } from '@curlew/store';

import { loadConfig, saveConfig } from '../core/config.ts';
import { ACCENT_CHOICES, type AccentChoice, isAccentChoice } from '../core/lib/appearance.ts';
import { applyAccent } from './appearance.ts';
import { silentVideosOn } from './video-preview-model.ts';
import { refreshSilentVideos } from './video-preview.ts';

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
  const modes = ['preview', 'sender', 'off'] as const;
  const notifications = new Adw.ComboRow({
    title: _('Message notifications'),
    subtitle: _('What a desktop notification for a new chat message shows'),
    model: Gtk.StringList.new([_('Sender and text'), _('Sender only'), _('Off')]),
    selected: Math.max(0, modes.indexOf(loadConfig(path).ui.notifications)),
  });
  const notifyGroup = new Adw.PreferencesGroup({ title: _('Notifications') });
  notifyGroup.add(notifications);
  const videos = new Adw.SwitchRow({
    title: _('Play videos silently in chats'),
    subtitle: _('A video in a conversation plays muted while it is on screen'),
    active: silentVideosOn(
      loadConfig(path).ui.playVideosSilently,
      Gtk.Settings.get_default()?.gtk_enable_animations ?? true,
    ),
  });
  const mediaGroup = new Adw.PreferencesGroup({ title: _('Media') });
  mediaGroup.add(videos);
  const accentLabels: Record<AccentChoice, string> = {
    default: _('Curlew blue'),
    system: _('Follow the system'),
    blue: _('Blue'),
    teal: _('Teal'),
    green: _('Green'),
    yellow: _('Yellow'),
    orange: _('Orange'),
    red: _('Red'),
    pink: _('Pink'),
    purple: _('Purple'),
    slate: _('Slate'),
  };
  const savedAccent = loadConfig(path).ui.accentColor;
  const accent = new Adw.ComboRow({
    title: _('Accent colour'),
    subtitle: _('Colours buttons, links and highlights'),
    model: Gtk.StringList.new(ACCENT_CHOICES.map((choice) => accentLabels[choice])),
    selected: Math.max(
      0,
      ACCENT_CHOICES.indexOf(savedAccent && isAccentChoice(savedAccent) ? savedAccent : 'default'),
    ),
  });
  const appearanceGroup = new Adw.PreferencesGroup({ title: _('Appearance') });
  appearanceGroup.add(accent);
  const page = new Adw.PreferencesPage();
  page.add(appearanceGroup);
  page.add(group);
  page.add(mediaGroup);
  page.add(notifyGroup);
  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(new Adw.HeaderBar());
  toolbar.set_content(page);
  overlay.set_child(toolbar);
  const dialog = new Adw.Dialog({ title: _('Preferences'), contentWidth: 520, contentHeight: 520 });
  dialog.set_child(overlay);

  row.connect('notify::active', () => {
    try {
      const config = loadConfig(path);
      config.ui.showAllEmails = row.get_active();
      saveConfig(config, path);
      onChanged();
    } catch (err) {
      overlay.add_toast(
        new Adw.Toast({ title: err instanceof Error ? err.message : String(err), timeout: 6 }),
      );
    }
  });
  videos.connect('notify::active', () => {
    try {
      const config = loadConfig(path);
      config.ui.playVideosSilently = videos.get_active();
      saveConfig(config, path);
      refreshSilentVideos();
    } catch (err) {
      overlay.add_toast(
        new Adw.Toast({ title: err instanceof Error ? err.message : String(err), timeout: 6 }),
      );
    }
  });
  accent.connect('notify::selected', () => {
    try {
      const config = loadConfig(path);
      const chosen = ACCENT_CHOICES[accent.get_selected()] ?? 'default';
      config.ui.accentColor = chosen;
      saveConfig(config, path);
      applyAccent(chosen);
    } catch (err) {
      overlay.add_toast(
        new Adw.Toast({ title: err instanceof Error ? err.message : String(err), timeout: 6 }),
      );
    }
  });
  notifications.connect('notify::selected', () => {
    try {
      const config = loadConfig(path);
      config.ui.notifications = modes[notifications.get_selected()] ?? 'preview';
      saveConfig(config, path);
    } catch (err) {
      overlay.add_toast(
        new Adw.Toast({ title: err instanceof Error ? err.message : String(err), timeout: 6 }),
      );
    }
  });
  dialog.present(parent);
}
