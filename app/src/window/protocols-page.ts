/**
 * The "Protocols" page of the Accounts dialog: one switch per protocol. Off means the daemon does
 * not start it and the window hides its chats; accounts and history stay, so switching back on
 * picks up where it left off.
 */

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { _, _n, fmt } from '@curlew/protocol';

import { backendsDisable, backendsEnable, backendsList } from '../core/actions/backends.ts';
import { switchableProtocols, type AddableProtocol } from './account-add-model.ts';
import { restartDaemonIfRunning } from './accounts-daemon.ts';

export interface ProtocolsPageDeps {
  navigation: Adw.NavigationView;
  path: string;
  /** Accounts per protocol, for the line under an enabled switch. */
  accountCounts: ReadonlyMap<string, number>;
  onError(err: Error): void;
  /** A protocol was switched: the caller reloads its list. */
  onChanged(): void;
  /** The widget the terms dialog is presented over. */
  parent(): Gtk.Widget;
}

function subtitleOf(protocol: AddableProtocol, count: number): string {
  if (!protocol.enabled) return protocol.terms !== null ? _('Asks you to accept terms first') : '';
  if (count === 0) return _('No accounts yet');
  return fmt(_n('{count} account', '{count} accounts', count), { count });
}

function askTerms(
  deps: ProtocolsPageDeps,
  protocol: AddableProtocol,
  done: (accepted: boolean) => void,
): void {
  const terms = protocol.terms;
  if (terms === null) return done(true);
  const dialog = new Adw.AlertDialog({ heading: _('Please read this first'), body: terms.summary });
  const extra = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
  if (terms.url) {
    extra.append(new Gtk.LinkButton({ uri: terms.url, label: terms.url, halign: Gtk.Align.CENTER }));
  }
  const risk = new Gtk.CheckButton({
    label: _('I understand and accept the risk for my account'),
    halign: Gtk.Align.CENTER,
  });
  extra.append(risk);
  dialog.set_extra_child(extra);
  dialog.add_response('cancel', _('Cancel'));
  dialog.add_response('accept', _('Accept and Turn On'));
  dialog.set_response_appearance('accept', Adw.ResponseAppearance.SUGGESTED);
  // Reading the notice is not accepting it: the response stays off until the box is ticked.
  dialog.set_response_enabled('accept', false);
  risk.connect('toggled', () => dialog.set_response_enabled('accept', risk.get_active()));
  dialog.set_default_response('cancel');
  dialog.set_close_response('cancel');
  dialog.connect('response', (_dialog: Adw.AlertDialog, response: string) => done(response === 'accept'));
  dialog.present(deps.parent());
}

export function pushProtocolsPage(deps: ProtocolsPageDeps): void {
  const protocols = switchableProtocols(backendsList(deps.path).backends);
  const group = new Adw.PreferencesGroup({
    description: _('Accounts and messages stay when a protocol is switched off.'),
  });
  for (const protocol of protocols) {
    const row = new Adw.SwitchRow({
      title: protocol.label,
      subtitle: subtitleOf(protocol, deps.accountCounts.get(protocol.backend) ?? 0),
      active: protocol.enabled,
      useMarkup: false,
    });
    row.add_prefix(new Gtk.Image({ iconName: protocol.icon }));
    let busy = false;
    const apply = (on: boolean, acceptTerms: boolean) => {
      try {
        if (on) backendsEnable(protocol.backend, { acceptTerms, path: deps.path });
        else backendsDisable(protocol.backend, deps.path);
      } catch (err) {
        deps.onError(err instanceof Error ? err : new Error(String(err)));
        revert(!on);
        return;
      }
      restartDaemonIfRunning();
      deps.onChanged();
    };
    const revert = (to: boolean) => {
      busy = true;
      row.set_active(to);
      busy = false;
    };
    row.connect('notify::active', () => {
      if (busy) return;
      const on = row.get_active();
      if (!on || protocol.terms === null) return apply(on, false);
      askTerms(deps, protocol, (accepted) => {
        if (accepted) apply(true, true);
        else revert(false);
      });
    });
    group.add(row);
  }

  const content = new Adw.PreferencesPage();
  content.add(group);
  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(new Adw.HeaderBar());
  toolbar.set_content(content);
  deps.navigation.push(new Adw.NavigationPage({ title: _('Protocols'), child: toolbar }));
}
