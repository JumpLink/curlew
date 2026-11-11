/**
 * The page of one chat account, pushed from the Accounts dialog: what state it is in and the one
 * action that cannot be undone, removing it. Removing only unlinks — see `accountRemove`.
 */

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';

import { accountRemove, accountSetEnabled } from '../core/actions/accounts.ts';
import { removeAccountCopy } from './account-remove-model.ts';
import { restartDaemonIfRunning } from './accounts-daemon.ts';
import type { AccountRow } from './accounts-model.ts';
import { accountStatusLabel } from './accounts-page.ts';

export interface AccountDetailDeps {
  navigation: Adw.NavigationView;
  /** The page to go back to once the account is gone. */
  root: Adw.NavigationPage;
  /** Where the page sits in the window, to anchor the confirmation. */
  parent: () => Gtk.Widget | null;
  path: string;
  backend: string;
  row: AccountRow;
  daemonPresent: boolean;
  onError(err: Error): void;
  /** The account was removed: the caller reloads its list. */
  onRemoved(): void;
  /** The account was switched on or off: the caller reloads its list. */
  onChanged(): void;
  /** The switch to run; the real one unless a probe substitutes it. */
  setEnabled?(backend: string, accountId: string, enabled: boolean): void;
  /** The removal to run; the real one unless a probe substitutes it. */
  remove?(backend: string, accountId: string): Promise<unknown>;
}

export function pushAccountPage(deps: AccountDetailDeps): void {
  const { row } = deps;
  const page = new Adw.PreferencesPage();

  const identity = new Adw.PreferencesGroup();
  identity.add(
    new Adw.Avatar({
      size: 72,
      text: row.label.replace(/^[@+\s]+/, '') || row.label,
      showInitials: true,
      halign: Gtk.Align.CENTER,
      marginBottom: 6,
    }),
  );
  identity.add(
    new Gtk.Label({
      label: row.label,
      wrap: true,
      justify: Gtk.Justification.CENTER,
      cssClasses: ['title-2'],
    }),
  );
  page.add(identity);

  const details = new Adw.PreferencesGroup();
  if (row.detail) {
    details.add(new Adw.ActionRow({ title: _('Account'), subtitle: row.detail, useMarkup: false }));
  }
  if (row.status && row.status !== 'disabled' && deps.daemonPresent) {
    details.add(
      new Adw.ActionRow({ title: _('Status'), subtitle: accountStatusLabel(row.status), useMarkup: false }),
    );
  }
  page.add(details);

  const sync = new Adw.PreferencesGroup({
    description: _('Off keeps the account linked and its messages here, but Curlew stops syncing it.'),
  });
  // Mail is read on demand, not held by the daemon, so there is nothing to switch off.
  sync.set_visible(deps.backend !== 'mail');
  const enabled = new Adw.SwitchRow({ title: _('Sync this account'), active: row.status !== 'disabled' });
  enabled.connect('notify::active', () => {
    try {
      (deps.setEnabled ?? ((b, id, on) => accountSetEnabled(b, id, on, deps.path)))(
        deps.backend,
        row.id,
        enabled.get_active(),
      );
    } catch (err) {
      deps.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    restartDaemonIfRunning();
    deps.onChanged();
  });
  sync.add(enabled);
  page.add(sync);

  const danger = new Adw.PreferencesGroup();
  const removeButton = new Gtk.Button({
    label: _('Remove Account…'),
    halign: Gtk.Align.CENTER,
    cssClasses: ['destructive-action', 'pill'],
  });
  danger.add(removeButton);
  page.add(danger);

  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(new Adw.HeaderBar());
  toolbar.set_content(page);
  const navPage = new Adw.NavigationPage({ title: row.label });
  navPage.set_child(toolbar);

  removeButton.connect('clicked', () => {
    const copy = removeAccountCopy(deps.backend, row.label);
    const dialog = new Adw.AlertDialog({ heading: copy.heading, body: copy.body });
    dialog.add_response('cancel', copy.cancel);
    dialog.add_response('remove', copy.confirm);
    dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');
    dialog.connect('response', (_dialog, response) => {
      if (response !== 'remove') return;
      removeButton.set_sensitive(false);
      void (deps.remove ?? ((b, id) => accountRemove(b, id, deps.path)))(deps.backend, row.id).then(
        () => {
          restartDaemonIfRunning();
          deps.onRemoved();
          deps.navigation.pop_to_page(deps.root);
        },
        (err: unknown) => {
          removeButton.set_sensitive(true);
          deps.onError(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
    dialog.present(deps.parent());
  });

  deps.navigation.push(navPage);
}
