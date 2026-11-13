/**
 * The "Protocols" page of the Accounts dialog: one switch per protocol. Off means the daemon does
 * not start it and the window hides its chats; accounts and history stay, so switching back on
 * picks up where it left off.
 */

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { _, _n, fmt } from '@curlew/protocol';

import { backendsDisable, backendsEnable, backendsList } from '../core/actions/backends.ts';

import { loadConfig, saveConfig } from '../core/config.ts';
import {
  applyDeltaChatAccounts,
  deltaChatRow,
  deltaChatSubtitle,
  switchableProtocols,
  type AddableProtocol,
} from './account-add-model.ts';
import { loadAccountsState } from './accounts-store.ts';
import { mailAccountChoices } from './welcome-model.ts';
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

/** The derived Delta Chat row: on opens the account choice, off opts every account out. */
function deltaChatSwitch(deps: ProtocolsPageDeps): Adw.SwitchRow {
  const state = () => deltaChatRow(backendsList(deps.path).backends, loadConfig(deps.path));
  const first = state();
  const row = new Adw.SwitchRow({
    title: first.label,
    subtitle: deltaChatSubtitle(first),
    active: first.enabled,
    sensitive: first.available,
    useMarkup: false,
  });
  row.add_prefix(new Gtk.Image({ iconName: first.icon }));
  let busy = false;
  const sync = () => {
    const now = state();
    busy = true;
    row.set_active(now.enabled);
    row.set_subtitle(deltaChatSubtitle(now));
    busy = false;
  };
  const save = (all: string[], chosen: Set<string>) => {
    try {
      const config = loadConfig(deps.path);
      applyDeltaChatAccounts(config, all, chosen);
      saveConfig(config, deps.path);
    } catch (err) {
      deps.onError(err instanceof Error ? err : new Error(String(err)));
    }
    sync();
    deps.onChanged();
  };
  row.connect('notify::active', () => {
    if (busy) return;
    if (!row.get_active()) {
      const all = (loadConfig(deps.path).deltaChatAccounts ?? []).slice();
      return save(all, new Set());
    }
    loadAccountsState(deps.path).then(
      (load) => {
        const choices = mailAccountChoices(load);
        if (choices.length === 0) {
          deps.onError(new Error(_('No mail account yet. Add one first.')));
          return sync();
        }
        const dialog = new Adw.AlertDialog({
          heading: _('Use Delta Chat for which accounts?'),
          body: _('Only these accounts send email chats. The others keep sending ordinary mail.'),
        });
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        const checks = choices.map((choice) => {
          const check = new Gtk.CheckButton({ label: choice.label, active: choices.length === 1 });
          box.append(check);
          return { id: choice.id, check };
        });
        dialog.set_extra_child(box);
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('apply', _('Turn On'));
        dialog.set_response_appearance('apply', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_close_response('cancel');
        dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
          const chosen = new Set(checks.filter((c) => c.check.get_active()).map((c) => c.id));
          if (response !== 'apply' || chosen.size === 0) return sync();
          save(
            choices.map((c) => c.id),
            chosen,
          );
        });
        dialog.present(deps.parent());
      },
      (err: unknown) => {
        deps.onError(err instanceof Error ? err : new Error(String(err)));
        sync();
      },
    );
  });
  return row;
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
    if (protocol.backend === 'mail') group.add(deltaChatSwitch(deps));
  }

  const content = new Adw.PreferencesPage();
  content.add(group);
  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(new Adw.HeaderBar());
  toolbar.set_content(content);
  deps.navigation.push(new Adw.NavigationPage({ title: _('Protocols'), child: toolbar }));
}
