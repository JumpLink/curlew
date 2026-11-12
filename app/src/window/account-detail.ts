/**
 * The page of one chat account, pushed from the Accounts dialog: what state it is in and the one
 * action that cannot be undone, removing it. Removing only unlinks — see `accountRemove`.
 */

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';

import {
  accountRemove,
  accountSetDeltaChat,
  accountSetEnabled,
  deltaChatEnabled,
} from '../core/actions/accounts.ts';
import { deleteDataCopy, removeAccountCopy } from './account-remove-model.ts';
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
  /** The Delta Chat opt-in to store; the real one unless a probe substitutes it. */
  setDeltaChat?(accountId: string, on: boolean): void;
  /** The removal to run; the real one unless a probe substitutes it. */
  remove?(backend: string, accountId: string, deleteData?: boolean): Promise<unknown>;
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

  const chat = new Adw.PreferencesGroup();
  chat.set_visible(deps.backend === 'mail');
  const deltaChat = new Adw.SwitchRow({
    title: _('Use for Delta Chat'),
    subtitle: _(
      'Messages from this account become email chats. People without Delta Chat see an ordinary email.',
    ),
    active: deps.backend === 'mail' && deltaChatEnabled(row.id, deps.path),
  });
  deltaChat.connect('notify::active', () => {
    try {
      (deps.setDeltaChat ?? ((id, on) => accountSetDeltaChat(id, on, deps.path)))(
        row.id,
        deltaChat.get_active(),
      );
    } catch (err) {
      deps.onError(err instanceof Error ? err : new Error(String(err)));
    }
  });
  chat.add(deltaChat);
  page.add(chat);

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
    const dataCopy = deleteDataCopy(deps.backend, row.label);
    const dialog = new Adw.AlertDialog({ heading: copy.heading, body: copy.body });
    const deleteData = new Gtk.CheckButton({ label: dataCopy.option });
    dialog.set_extra_child(deleteData);
    dialog.add_response('cancel', copy.cancel);
    dialog.add_response('remove', copy.confirm);
    dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');

    const run = (withData: boolean) => {
      removeButton.set_sensitive(false);
      void (deps.remove ?? ((b, id, data) => accountRemove(b, id, deps.path, { deleteData: data })))(
        deps.backend,
        row.id,
        withData,
      ).then(
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
    };

    dialog.connect('response', (_dialog, response) => {
      if (response !== 'remove') return;
      if (!deleteData.get_active()) {
        run(false);
        return;
      }
      const confirm = new Adw.AlertDialog({ heading: dataCopy.heading, body: dataCopy.body });
      confirm.add_response('cancel', dataCopy.cancel);
      confirm.add_response('delete', dataCopy.confirm);
      confirm.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
      confirm.set_default_response('cancel');
      confirm.set_close_response('cancel');
      confirm.connect('response', (_d, r) => {
        if (r === 'delete') run(true);
      });
      confirm.present(deps.parent());
    });
    dialog.present(deps.parent());
  });

  deps.navigation.push(navPage);
}
