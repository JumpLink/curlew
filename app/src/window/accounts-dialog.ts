/**
 * The "Accounts" dialog, opened from the primary menu and the empty state of the conversation
 * list. It loads accounts once when opened and follows the daemon while it stays open.
 */

import Adw from 'gi://Adw?version=1';
import type Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';
import { configPath } from '@curlew/store';

import { buildProtocolGroups, type AccountsDaemonState, type AccountsPageState } from './accounts-model.ts';
import { pushAddAccountPage } from './account-add.ts';
import { pushAccountPage } from './account-detail.ts';
import { createAccountsPage, openGoaSettings } from './accounts-page.ts';
import { gioAccountsDaemonSource, startDaemon } from './accounts-daemon.ts';
import { inSandbox } from '../core/lib/sandbox.ts';
import { loadAccountsState } from './accounts-store.ts';

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
  const page: ReturnType<typeof createAccountsPage> = createAccountsPage(
    onError,
    () =>
      pushAddAccountPage({
        navigation: page.navigation,
        root: page.root,
        path,
        onError,
        onAdded: () => void reload(),
        openGoaSettings: () => openGoaSettings(onError),
      }),
    (group, row, daemonPresent) =>
      pushAccountPage({
        navigation: page.navigation,
        root: page.root,
        parent: () => page.widget,
        path,
        backend: group.backend,
        row,
        daemonPresent,
        onError,
        onRemoved: () => void reload(),
        onChanged: () => void reload(),
      }),
    () => void startDaemon().catch((err: Error) => onError(err)),
  );

  // The page is a navigation view with its own header bar, so the next pages get a back button.
  overlay.set_child(page.widget);

  const dialog = new Adw.Dialog({
    title: _('Accounts'),
    contentWidth: options.width ?? 360,
    contentHeight: options.height ?? 560,
  });
  dialog.set_child(overlay);

  let open = true;
  let loadState: Awaited<ReturnType<typeof loadAccountsState>> | null = null;
  // Null until the bus has answered, so the dialog never claims "daemon not running" while it is still asking.
  let daemonState: AccountsDaemonState | null = null;
  let loading = false;
  let again = false;

  const render = () => {
    if (!open || !loadState || !daemonState) return;
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
      loadState = await loadAccountsState(path, { hostAccounts: !inSandbox() });
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

  page.showLoading();
  const stopDaemon = gioAccountsDaemonSource().start(onDaemon);
  void reload();

  dialog.connect('closed', () => {
    open = false;
    stopDaemon();
  });
  dialog.present(parent);
}
