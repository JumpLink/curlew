/**
 * The "Agent access" page (ADR 0009, step 5): the widgets only. What is shown and every edit are
 * in `agent-access-model.ts`; the file is touched by the caller through `onEdit`.
 *
 * Plain Adw widgets: a switch row for `askWithoutRule`, one preferences group per account with an
 * expander row per rule, and an `Adw.Dialog` to add a rule. The page never writes anything itself
 * and never refreshes itself after an edit — the caller reloads the file and calls `show` again,
 * which is also what an external change does.
 */

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { _, fmt } from '@curlew/protocol';

import {
  type AccountView,
  type Choice,
  CHOICES,
  type EditError,
  type EditResult,
  type PolicyEdit,
  type RuleView,
  addRule,
  removeRule,
  ruleTitle,
  setAskWithoutRule,
  setMode,
} from './agent-access-model.ts';

export interface KnownAccount {
  id: string;
  label: string;
}

export interface PageState {
  askWithoutRule: boolean;
  groups: AccountView[];
  /** Accounts the enabled backends report, for the add dialog's picker. */
  accounts: KnownAccount[];
}

export interface AgentAccessPage {
  widget: Gtk.Widget;
  show(state: PageState): void;
  /** The config could not be read: say so instead of showing rules that are not there. */
  showError(message: string): void;
}

function choiceLabel(choice: Choice): string {
  switch (choice) {
    case 'allow':
      return _('Allow');
    case 'ask':
      return _('Ask');
    case 'deny':
      return _('Deny');
    default:
      return _('Not set');
  }
}

export function errorText(error: EditError, detail?: string): string {
  switch (error) {
    case 'write-needs-read':
      return _('A conversation an agent may write to is one it may read. Allow reading first.');
    case 'needs-mode':
      return _('A rule needs a mode for reading or for writing.');
    case 'duplicate':
      return _('There is already a rule for this account and contact.');
    case 'missing':
      return _('That rule is gone — the list was updated.');
    case 'migrated':
      return _('This rule comes from an old send grant. Change a mode to make it a rule of its own.');
    default:
      return detail ? fmt(_('That rule is not valid: {detail}'), { detail }) : _('That rule is not valid.');
  }
}

function modeLine(rule: RuleView): string {
  return fmt(_('Read: {read} · Write: {write}'), {
    read: choiceLabel(rule.read),
    write: choiceLabel(rule.write),
  });
}

function choiceRow(title: string, selected: Choice): Adw.ComboRow {
  return new Adw.ComboRow({
    title,
    model: Gtk.StringList.new(CHOICES.map(choiceLabel)),
    selected: CHOICES.indexOf(selected),
  });
}

const choiceOf = (row: Adw.ComboRow): Choice => CHOICES[row.get_selected()] ?? 'unset';
const keyOf = (rule: { account: string; contact?: string }): string =>
  JSON.stringify([rule.account, rule.contact ?? null]);

export function createAgentAccessPage(
  onEdit: (edit: PolicyEdit) => EditResult,
  toast: (title: string) => void,
  parent: () => Gtk.Window | null,
): AgentAccessPage {
  const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 24 });
  const clamp = new Adw.Clamp({
    maximumSize: 640,
    marginTop: 12,
    marginBottom: 24,
    marginStart: 12,
    marginEnd: 12,
  });
  clamp.set_child(column);
  const scroller = new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true });
  scroller.set_child(clamp);

  // Rebuilding the lists would collapse every row the person opened; the keys survive a rebuild.
  const expanded = new Set<string>();
  let accounts: KnownAccount[] = [];
  // Set while the widgets are filled from the file, so setting a value is not mistaken for an edit.
  let filling = false;
  let parts: Gtk.Widget[] = [];

  const apply = (edit: PolicyEdit): boolean => {
    const result = onEdit(edit);
    if (!result.ok) toast(errorText(result.error, result.detail));
    return result.ok;
  };

  const clear = () => {
    for (const part of parts) column.remove(part);
    parts = [];
  };
  const add = (widget: Gtk.Widget) => {
    column.append(widget);
    parts.push(widget);
  };

  const ruleRow = (rule: RuleView, group: AccountView): Adw.ExpanderRow => {
    const key = keyOf(rule);
    const row = new Adw.ExpanderRow({
      title: ruleTitle(rule, _('Whole account')),
      subtitle: modeLine(rule),
      expanded: expanded.has(key),
    });
    row.connect('notify::expanded', () => {
      if (filling) return;
      if (row.get_expanded()) expanded.add(key);
      else expanded.delete(key);
    });
    if (!rule.migrated) {
      const remove = Gtk.Button.new_from_icon_name('user-trash-symbolic');
      remove.set_valign(Gtk.Align.CENTER);
      remove.add_css_class('flat');
      remove.set_tooltip_text(_('Remove this rule'));
      remove.connect('clicked', () => {
        apply(removeRule(rule));
      });
      row.add_suffix(remove);
    }
    if (rule.migrated) {
      row.add_row(
        new Adw.ActionRow({
          title: _('From an old send grant'),
          subtitle: _(
            'Changing a mode makes this a rule of its own. The grant stays in your configuration, and removing the rule brings this one back.',
          ),
          focusable: false,
        }),
      );
    }
    for (const kind of ['read', 'write'] as const) {
      const combo = choiceRow(kind === 'read' ? _('Read messages') : _('Send messages'), rule[kind]);
      combo.connect('notify::selected', () => {
        if (filling) return;
        apply(setMode(rule, kind, choiceOf(combo)));
      });
      row.add_row(combo);
    }
    void group;
    return row;
  };

  const showDialog = () => {
    const dialog = new Adw.Dialog({ title: _('Add a rule'), contentWidth: 420 });
    const group = new Adw.PreferencesGroup();

    let accountCombo: Adw.ComboRow | null = null;
    let accountEntry: Adw.EntryRow | null = null;
    if (accounts.length > 0) {
      accountCombo = new Adw.ComboRow({
        title: _('Account'),
        model: Gtk.StringList.new(accounts.map((a) => a.label)),
      });
      group.add(accountCombo);
    } else {
      accountEntry = new Adw.EntryRow({ title: _('Account id') });
      group.add(accountEntry);
    }
    const contact = new Adw.EntryRow({ title: _('Contact address (empty = the whole account)') });
    const read = choiceRow(_('Read messages'), 'allow');
    const write = choiceRow(_('Send messages'), 'ask');
    for (const row of [contact, read, write]) group.add(row);

    const problem = new Gtk.Label({ wrap: true, xalign: 0, visible: false });
    problem.add_css_class('error');

    const cancel = Gtk.Button.new_with_label(_('Cancel'));
    cancel.connect('clicked', () => dialog.close());
    const submit = Gtk.Button.new_with_label(_('Add'));
    submit.add_css_class('suggested-action');
    submit.connect('clicked', () => {
      const account = accountCombo
        ? (accounts[accountCombo.get_selected()]?.id ?? '')
        : (accountEntry?.get_text() ?? '');
      const readChoice = choiceOf(read);
      const writeChoice = choiceOf(write);
      const result = onEdit(
        addRule({
          account,
          contact: contact.get_text(),
          ...(readChoice !== 'unset' ? { read: readChoice } : {}),
          ...(writeChoice !== 'unset' ? { write: writeChoice } : {}),
        }),
      );
      if (result.ok) {
        dialog.close();
        return;
      }
      problem.set_label(errorText(result.error, result.detail));
      problem.set_visible(true);
    });

    const header = new Adw.HeaderBar({ showStartTitleButtons: false, showEndTitleButtons: false });
    header.pack_start(cancel);
    header.pack_end(submit);
    const body = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 12,
      marginTop: 12,
      marginBottom: 24,
      marginStart: 12,
      marginEnd: 12,
    });
    body.append(group);
    body.append(problem);
    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(header);
    toolbar.set_content(body);
    dialog.set_child(toolbar);
    dialog.set_default_widget(submit);
    dialog.present(parent());
  };

  return {
    widget: scroller,
    showError(message) {
      clear();
      const status = new Adw.StatusPage({
        iconName: 'dialog-warning-symbolic',
        title: _('The configuration could not be read'),
        description: message,
      });
      add(status);
    },
    show(state) {
      filling = true;
      clear();
      accounts = state.accounts;

      const general = new Adw.PreferencesGroup({
        description: _(
          'Your own commands and this window are never restricted, and your own addresses are always allowed. These rules decide what an AI agent may read and send.',
        ),
      });
      const ask = new Adw.SwitchRow({
        title: _('Ask when no rule applies'),
        subtitle: _('Off: an agent request without a rule is refused without asking'),
        active: state.askWithoutRule,
      });
      ask.connect('notify::active', () => {
        if (filling) return;
        apply(setAskWithoutRule(ask.get_active()));
      });
      general.add(ask);
      add(general);

      for (const account of state.groups) {
        const group = new Adw.PreferencesGroup({ title: account.label });
        if (account.label !== account.account) group.set_description(account.account);
        if (account.whole) group.add(ruleRow(account.whole, account));
        for (const contact of account.contacts) group.add(ruleRow(contact, account));
        add(group);
      }
      if (state.groups.length === 0) {
        const none = new Gtk.Label({ label: _('No rules yet'), wrap: true });
        none.add_css_class('dim-label');
        add(none);
      }

      const addButton = Gtk.Button.new_with_label(_('Add rule'));
      addButton.set_halign(Gtk.Align.CENTER);
      addButton.add_css_class('pill');
      addButton.connect('clicked', showDialog);
      add(addButton);
      filling = false;
    },
  };
}
