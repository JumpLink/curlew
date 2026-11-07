/**
 * The "Accounts" dialog, opened from the primary menu and the empty state of the conversation
 * list. It loads accounts once when opened and follows the daemon while it stays open.
 */

import Adw from 'gi://Adw?version=1';
import type Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';
import { configPath } from '@curlew/store';

import {
  buildProtocolGroups,
  loadingGroups,
  type AccountsDaemonState,
  type AccountsPageState,
} from './accounts-model.ts';
import { createAccountsPage } from './accounts-page.ts';
import { gioAccountsDaemonSource } from './accounts-daemon.ts';
import { loadAccountsState } from './accounts-store.ts';
import { backendsList } from '../core/actions/backends.ts';

export interface AccountsDialogOptions {
  /** Width of the dialog content; defaults to 360. */
  width?: number;
  /** Height of the dialog content; defaults to 560. */
  height?: number;
}

export function presentAccounts(parent: Gtk.Window | null, options: AccountsDialogOptions = {}): void {
  const path = configPath();
  const overlay = new Adw.ToastOverlay();
  const onError = (err: Error) => overlay.add_toast(new Adw.Toast({ title: err.message, timeout: 4 }));
  const page = createAccountsPage(onError);

  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(new Adw.HeaderBar());
  toolbar.set_content(page.widget);
  overlay.set_child(toolbar);

  const dialog = new Adw.Dialog({
    title: _('Accounts'),
    contentWidth: options.width ?? 360,
    contentHeight: options.height ?? 560,
  });
  dialog.set_child(overlay);

  let open = true;
  let loadState: Awaited<ReturnType<typeof loadAccountsState>> | null = null;
  let daemonState: AccountsDaemonState = { present: false, accounts: new Map() };
  let loading = false;
  let again = false;

  const render = () => {
    if (!open || !loadState) return;
    const state: AccountsPageState = buildProtocolGroups(loadState, daemonState);
    page.show(state);
  };

  async function reload(): Promise<void> {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    try {
      loadState = await loadAccountsState(path);
      if (!open) return;
      render();
    } catch (err) {
      page.showError(err instanceof Error ? err.message : String(err));
    } finally {
      loading = false;
      if (again && open) {
        again = false;
        void reload();
      }
    }
  }

  const onDaemon = (state: AccountsDaemonState) => {
    daemonState = state;
    render();
  };

  page.show({ groups: loadingGroups(backendsList(path).backends), daemonPresent: false });
  const stopDaemon = gioAccountsDaemonSource().start(onDaemon);
  void reload();

  dialog.connect('closed', () => {
    open = false;
    stopDaemon();
  });
  dialog.present(parent);
}
