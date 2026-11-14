/**
 * The widgets of the Accounts dialog. Pure layout and event wiring; what is shown comes from
 * `accounts-model.ts` and the caller reloads it.
 */

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';

import { chatOnly } from '../core/platform.ts';
import { DELTA_CHAT } from '../core/visibility.ts';
import { protocolLabel } from './conversation-list-model.ts';
import { accountSubtitle } from './accounts-model.ts';
import type { AccountRow, AccountStatus, AccountsPageState, ProtocolGroup } from './accounts-model.ts';

export interface AccountsPage {
  widget: Gtk.Widget;
  navigation: Adw.NavigationView;
  /** The page of the account list, which later pages return to. */
  root: Adw.NavigationPage;
  /** Until both the accounts and the daemon have answered, so no half-true state flashes by. */
  showLoading(): void;
  show(state: AccountsPageState): void;
  showError(message: string): void;
}

export function accountStatusLabel(status: AccountStatus): string {
  switch (status) {
    case 'connected':
      return _('Connected');
    case 'connecting':
      return _('Connecting');
    case 'offline':
      return _('Offline');
    case 'daemon-not-running':
      return _('Daemon not running');
    case 'disabled':
      return _('Off');
  }
}

export function openGoaSettings(onError: (err: Error) => void): void {
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

function buildRow(row: AccountRow, daemonPresent: boolean, onOpen: (() => void) | null): Adw.ActionRow {
  // The state and the Delta Chat note ride in the subtitle, not as suffixes: two badges next to a
  // long address squeezed the title until it broke inside the word.
  const status =
    row.status && (daemonPresent || row.status === 'disabled') ? accountStatusLabel(row.status) : null;
  const widget = new Adw.ActionRow({
    title: row.label,
    subtitle: accountSubtitle([status, row.deltaChat ? protocolLabel(DELTA_CHAT) : null, row.detail]),
    useMarkup: false,
    activatable: onOpen !== null,
    titleLines: 1,
    subtitleLines: 2,
  });
  widget.add_prefix(
    new Adw.Avatar({
      size: 36,
      // A leading "@" or "+" is syntax, not part of the name, and would become the initial.
      text: row.label.replace(/^[@+\s]+/, '') || row.label,
      showInitials: true,
      valign: Gtk.Align.CENTER,
    }),
  );
  if (onOpen) {
    widget.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic' }));
    widget.connect('activated', onOpen);
  }
  return widget;
}

function buildMessageRow(title: string, subtitle: string | null, icon: string | null): Adw.ActionRow {
  const row = new Adw.ActionRow({ title, subtitle: subtitle ?? '', useMarkup: false, activatable: false });
  if (icon) row.add_prefix(new Gtk.Image({ iconName: icon }));
  return row;
}

function buildGroup(
  group: ProtocolGroup,
  daemonPresent: boolean,
  onError: (err: Error) => void,
  onOpenAccount: (group: ProtocolGroup, row: AccountRow) => void,
): Adw.PreferencesGroup {
  const prefGroup = new Adw.PreferencesGroup({ title: group.label });

  // One group answers everything about its protocol: the accounts, their state and, for mail
  // accounts from the system, where to manage them.
  if (group.isGoa) {
    const manage = new Gtk.Button({
      label: _('Manage…'),
      tooltipText: _('Open GNOME Settings → Online Accounts'),
      cssClasses: ['flat'],
      valign: Gtk.Align.CENTER,
    });
    manage.connect('clicked', () => openGoaSettings(onError));
    prefGroup.set_header_suffix(manage);
  }

  if (group.error) {
    prefGroup.add(buildMessageRow(_('Could not load accounts'), group.error, 'dialog-warning-symbolic'));
  } else if (group.rows.length === 0) {
    prefGroup.add(buildMessageRow(_('No accounts yet'), null, null));
  } else {
    for (const row of group.rows) {
      // A GNOME Online Account's page holds Curlew's own switches; the login stays in GNOME Settings.
      prefGroup.add(buildRow(row, daemonPresent, () => onOpenAccount(group, row)));
    }
  }
  return prefGroup;
}

export function createAccountsPage(
  onError: (err: Error) => void,
  onAdd: () => void,
  onOpenAccount: (group: ProtocolGroup, row: AccountRow, daemonPresent: boolean) => void,
  onStartDaemon: () => void,
  onOpenProtocols: () => void,
): AccountsPage {
  const preferencesPage = new Adw.PreferencesPage();
  const loading = new Adw.Spinner({
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
    widthRequest: 32,
    heightRequest: 32,
  });
  const errorPage = new Adw.StatusPage({
    iconName: 'dialog-warning-symbolic',
    title: _('Accounts could not be loaded'),
  });
  const emptyPage = new Adw.StatusPage({
    iconName: 'user-info-symbolic',
    title: _('No accounts'),
    description: chatOnly() ? _('Add a chat account.') : _('Add a chat account or a mail account.'),
  });
  const emptyAdd = new Gtk.Button({
    label: _('Add Account'),
    halign: Gtk.Align.CENTER,
    cssClasses: ['suggested-action', 'pill'],
  });
  emptyAdd.connect('clicked', onAdd);
  emptyPage.set_child(emptyAdd);
  const stack = new Gtk.Stack();
  stack.add_named(loading, 'loading');
  stack.add_named(preferencesPage, 'content');
  stack.add_named(errorPage, 'error');
  stack.add_named(emptyPage, 'empty');
  stack.set_visible_child_name('loading');

  const banner = new Adw.Banner({
    title: _('The background service is not running, so chat accounts cannot connect.'),
    buttonLabel: _('Start'),
    revealed: false,
  });
  banner.connect('button-clicked', onStartDaemon);
  const toolbar = new Adw.ToolbarView();
  const header = new Adw.HeaderBar();
  const addButton = new Gtk.Button({
    iconName: 'list-add-symbolic',
    tooltipText: _('Add Account'),
  });
  addButton.connect('clicked', onAdd);
  header.pack_start(addButton);
  const protocolsButton = new Gtk.Button({
    iconName: 'preferences-system-symbolic',
    tooltipText: _('Protocols'),
  });
  protocolsButton.connect('clicked', onOpenProtocols);
  header.pack_end(protocolsButton);
  toolbar.add_top_bar(header);
  toolbar.add_top_bar(banner);
  toolbar.set_content(stack);
  const navPage = new Adw.NavigationPage({ title: _('Accounts') });
  navPage.set_child(toolbar);
  const navView = new Adw.NavigationView();
  navView.add(navPage);

  // `get_first_child` of a preferences page is its own scrolled window, not a group, so the
  // groups are tracked here to be removed again.
  let shown: Adw.PreferencesGroup[] = [];
  const clearGroups = () => {
    for (const group of shown) preferencesPage.remove(group);
    shown = [];
  };

  return {
    widget: navView,
    navigation: navView,
    root: navPage,
    showLoading() {
      stack.set_visible_child_name('loading');
    },
    showError(message) {
      errorPage.set_description(message);
      stack.set_visible_child_name('error');
    },
    show(state) {
      clearGroups();
      banner.set_revealed(!state.daemonPresent);
      for (const group of state.groups) {
        const widget = buildGroup(group, state.daemonPresent, onError, (g, row) =>
          onOpenAccount(g, row, state.daemonPresent),
        );
        shown.push(widget);
        preferencesPage.add(widget);
      }
      stack.set_visible_child_name(state.groups.length === 0 ? 'empty' : 'content');
    },
  };
}
