/**
 * The widgets of the Accounts dialog. Pure layout and event wiring; what is shown comes from
 * `accounts-model.ts` and the caller reloads it.
 */

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';

import type { AccountRow, AccountStatus, AccountsPageState, ProtocolGroup } from './accounts-model.ts';

export interface AccountsPage {
  widget: Gtk.Widget;
  show(state: AccountsPageState): void;
  showError(message: string): void;
}

function statusLabel(status: AccountStatus): string {
  switch (status) {
    case 'connected':
      return _('Connected');
    case 'connecting':
      return _('Connecting');
    case 'offline':
      return _('Offline');
    case 'daemon-not-running':
      return _('Daemon not running');
  }
}

function openGoaSettings(onError: (err: Error) => void): void {
  try {
    const appInfo = Gio.AppInfo.create_from_commandline(
      'gnome-control-center online-accounts',
      'GNOME Settings',
      Gio.AppInfoCreateFlags.NONE,
    );
    appInfo.launch([], null);
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

function buildRow(row: AccountRow): Adw.ActionRow {
  return new Adw.ActionRow({ title: row.label, subtitle: statusLabel(row.status) });
}

function buildLoadingRow(): Adw.ActionRow {
  const spinner = new Gtk.Spinner({ spinning: true });
  const row = new Adw.ActionRow({ title: _('Loading…'), activatable: false });
  row.add_prefix(spinner);
  return row;
}

function buildErrorRow(message: string): Adw.ActionRow {
  const row = new Adw.ActionRow({ title: _('Could not load accounts'), subtitle: message });
  row.add_prefix(new Gtk.Image({ iconName: 'dialog-warning-symbolic' }));
  return row;
}

function buildEmptyRow(): Adw.ActionRow {
  return new Adw.ActionRow({ title: _('No accounts'), activatable: false });
}

function buildGoaSettingsRow(onError: (err: Error) => void): Adw.ActionRow {
  const row = new Adw.ActionRow({
    title: _('Online Accounts'),
    subtitle: _('Open GNOME Settings'),
    activatable: true,
  });
  row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic' }));
  row.connect('activated', () => openGoaSettings(onError));
  return row;
}

function buildGroup(group: ProtocolGroup, onError: (err: Error) => void): Adw.PreferencesGroup {
  const prefGroup = new Adw.PreferencesGroup({ title: group.label });
  if (group.description) prefGroup.set_description(group.description);

  if (group.loading) {
    prefGroup.add(buildLoadingRow());
  } else if (group.error) {
    prefGroup.add(buildErrorRow(group.error));
  } else if (group.rows.length === 0) {
    prefGroup.add(buildEmptyRow());
  } else {
    for (const row of group.rows) prefGroup.add(buildRow(row));
  }

  if (group.isGoa) prefGroup.add(buildGoaSettingsRow(onError));
  return prefGroup;
}

export function createAccountsPage(onError: (err: Error) => void): AccountsPage {
  const preferencesPage = new Adw.PreferencesPage();
  const errorPage = new Adw.StatusPage({
    iconName: 'dialog-warning-symbolic',
    title: _('Accounts could not be loaded'),
  });
  const emptyPage = new Adw.StatusPage({
    iconName: 'user-info-symbolic',
    title: _('No accounts'),
    description: _('Enable a backend in Preferences to add accounts here.'),
  });
  const stack = new Gtk.Stack();
  stack.add_named(preferencesPage, 'content');
  stack.add_named(errorPage, 'error');
  stack.add_named(emptyPage, 'empty');

  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(new Adw.HeaderBar());
  toolbar.set_content(stack);
  const navPage = new Adw.NavigationPage({ title: _('Accounts') });
  navPage.set_child(toolbar);
  const navView = new Adw.NavigationView();
  navView.add(navPage);

  const clearGroups = () => {
    let child = preferencesPage.get_first_child();
    while (child) {
      const next = child.get_next_sibling();
      if (child instanceof Adw.PreferencesGroup) preferencesPage.remove(child);
      child = next;
    }
  };

  return {
    widget: navView,
    showError(message) {
      errorPage.set_description(message);
      stack.set_visible_child_name('error');
    },
    show(state) {
      clearGroups();
      for (const group of state.groups) preferencesPage.add(buildGroup(group, onError));
      if (state.groups.length === 0) {
        stack.set_visible_child_name('empty');
      } else {
        stack.set_visible_child_name('content');
      }
    },
  };
}
