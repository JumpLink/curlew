/** App-wide presentation settings; agent permissions stay in their own dialog. */

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _, errorMessage } from '@curlew/protocol';
import { configPath } from '@curlew/store';

import { chatOnly } from '../core/platform.ts';
import { aiEnabled, loadConfig, saveConfig } from '../core/config.ts';
import { chatOnlyAccountIds } from '../core/visibility.ts';
import { appearanceGroups, type AppearanceStore } from './appearance-rows.ts';
import { showAllEmailsSubtitle } from './email-chat-model.ts';
import { silentVideosOn } from './video-preview-model.ts';
import { refreshSilentVideos } from './video-preview.ts';

function appearanceStore(path: string, overlay: Adw.ToastOverlay): AppearanceStore {
  return {
    read: () => loadConfig(path).ui,
    write(change) {
      try {
        const config = loadConfig(path);
        Object.assign(config.ui, change);
        saveConfig(config, path);
      } catch (err) {
        overlay.add_toast(new Adw.Toast({ title: errorMessage(err), timeout: 6 }));
      }
    },
  };
}

export function presentPreferences(
  parent: Gtk.Window | null,
  onChanged: () => void,
  onAiChanged: () => void = () => {},
): void {
  const path = configPath();
  const overlay = new Adw.ToastOverlay();
  const row = new Adw.SwitchRow({
    title: _('Show all emails'),
    subtitle: showAllEmailsSubtitle(chatOnlyAccountIds(loadConfig(path)).length),
    active: loadConfig(path).ui.showAllEmails,
  });
  const group = new Adw.PreferencesGroup({ title: _('Conversations') });
  // "Show all emails" filters mail, which a chat-only platform does not have.
  if (!chatOnly()) group.add(row);
  const receipts = new Adw.SwitchRow({
    title: _('Send read receipts'),
    subtitle: _(
      'Tell the other person when you have read their message. On Delta Chat only if they asked for it',
    ),
    active: loadConfig(path).ui.sendReadReceipts === true,
  });
  group.add(receipts);
  const syncRead = new Adw.SwitchRow({
    title: _('Sync read state to your other devices'),
    subtitle: _(
      'Your other devices show what you have read here. On Telegram and WhatsApp the other person sees it too, so there only with read receipts on',
    ),
    active: loadConfig(path).ui.syncReadState !== false,
  });
  group.add(syncRead);
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
  const ai = new Adw.SwitchRow({
    title: _('AI features'),
    subtitle: _(
      'Let AI assistants read and send your messages through Curlew, each time as you allow it. Off: no assistant can reach your data',
    ),
    active: aiEnabled(loadConfig(path)),
  });
  const aiGroup = new Adw.PreferencesGroup({ title: _('AI') });
  aiGroup.add(ai);
  const page = new Adw.PreferencesPage();
  for (const appearance of appearanceGroups(appearanceStore(path, overlay))) page.add(appearance);
  if (!chatOnly()) page.add(group);
  page.add(mediaGroup);
  page.add(notifyGroup);
  page.add(aiGroup);
  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(new Adw.HeaderBar());
  toolbar.set_content(page);
  overlay.set_child(toolbar);
  const dialog = new Adw.Dialog({ title: _('Preferences'), contentWidth: 520, contentHeight: 700 });
  dialog.set_child(overlay);

  row.connect('notify::active', () => {
    try {
      const config = loadConfig(path);
      config.ui.showAllEmails = row.get_active();
      saveConfig(config, path);
      onChanged();
    } catch (err) {
      overlay.add_toast(new Adw.Toast({ title: errorMessage(err), timeout: 6 }));
    }
  });
  receipts.connect('notify::active', () => {
    try {
      const config = loadConfig(path);
      config.ui.sendReadReceipts = receipts.get_active();
      saveConfig(config, path);
    } catch (err) {
      overlay.add_toast(new Adw.Toast({ title: errorMessage(err), timeout: 6 }));
    }
  });
  syncRead.connect('notify::active', () => {
    try {
      const config = loadConfig(path);
      config.ui.syncReadState = syncRead.get_active();
      saveConfig(config, path);
    } catch (err) {
      overlay.add_toast(new Adw.Toast({ title: errorMessage(err), timeout: 6 }));
    }
  });
  videos.connect('notify::active', () => {
    try {
      const config = loadConfig(path);
      config.ui.playVideosSilently = videos.get_active();
      saveConfig(config, path);
      refreshSilentVideos();
    } catch (err) {
      overlay.add_toast(new Adw.Toast({ title: errorMessage(err), timeout: 6 }));
    }
  });
  ai.connect('notify::active', () => {
    try {
      const config = loadConfig(path);
      config.ui.ai = ai.get_active();
      saveConfig(config, path);
      onAiChanged();
    } catch (err) {
      overlay.add_toast(new Adw.Toast({ title: errorMessage(err), timeout: 6 }));
    }
  });
  notifications.connect('notify::selected', () => {
    try {
      const config = loadConfig(path);
      config.ui.notifications = modes[notifications.get_selected()] ?? 'preview';
      saveConfig(config, path);
    } catch (err) {
      overlay.add_toast(new Adw.Toast({ title: errorMessage(err), timeout: 6 }));
    }
  });
  dialog.present(parent);
  // The screenshot hook `CURLEW_PREFERENCES_SCROLL_TO_SYNC=1` brings the read-state switch into view.
  if (process.env.CURLEW_PREFERENCES_SCROLL_TO_SYNC === '1')
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => (syncRead.grab_focus(), GLib.SOURCE_REMOVE));
}
