/**
 * The merge assistant: one set of similar-looking people per step, ticked by default. Merge joins
 * the ticked rows, Skip remembers the set. Adwaita's own widgets only.
 */

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { _, _n, fmt } from '@curlew/protocol';

import { type ListEntry, listSubtitle, shortTime } from './conversation-list-model.ts';
import { type CandidateSet, answerSet } from './merge-candidates-model.ts';

export interface MergeAssistantTools {
  merge(personIds: string[]): void;
  decline(personIds: string[]): void;
  /** The dialog is gone: refresh the list once, not after every step. */
  closed(): void;
}

function personRow(
  entry: ListEntry,
  labels: ReadonlyMap<string, string>,
  ticked: Set<string>,
  onToggle: () => void,
) {
  const row = new Adw.ActionRow({
    title: entry.title,
    subtitle: listSubtitle(entry, labels),
    activatable: true,
  });
  row.set_title_lines(1);
  row.set_subtitle_lines(1);
  const check = new Gtk.CheckButton({
    active: true,
    valign: Gtk.Align.CENTER,
    canTarget: false,
    focusable: false,
  });
  check.add_css_class('selection-mode');
  row.add_prefix(check);
  row.add_prefix(new Adw.Avatar({ size: 40, text: entry.title, showInitials: true }));
  const when = shortTime(entry.lastMessageAt);
  if (when !== '') {
    const time = new Gtk.Label({ label: when, valign: Gtk.Align.CENTER });
    time.add_css_class('dim-label');
    time.add_css_class('caption');
    row.add_suffix(time);
  }
  row.connect('activated', () => {
    check.set_active(!check.get_active());
    if (check.get_active()) ticked.add(entry.id);
    else ticked.delete(entry.id);
    onToggle();
  });
  ticked.add(entry.id);
  return row;
}

export function presentMergeAssistant(
  parent: Gtk.Widget | null,
  sets: CandidateSet[],
  labels: ReadonlyMap<string, string>,
  tools: MergeAssistantTools,
): void {
  const dialog = new Adw.Dialog({ title: _('Merge contacts'), contentWidth: 360, contentHeight: 520 });
  const header = new Adw.HeaderBar();
  const view = new Adw.ToolbarView();
  view.add_top_bar(header);
  const stack = new Gtk.Stack({ transitionType: Gtk.StackTransitionType.SLIDE_LEFT });
  view.set_content(stack);
  dialog.set_child(view);

  let step = 0;
  let merged = 0;
  const advance = () => {
    step += 1;
    show();
  };
  const show = () => {
    const set = sets[step];
    const name = `step-${step}`;
    if (!set) {
      const done = new Adw.StatusPage({
        iconName: 'emblem-ok-symbolic',
        title:
          merged > 0 ? fmt(_n('{count} merged', '{count} merged', merged), { count: merged }) : _('All done'),
        description: _('You can separate merged people again from the conversation list.'),
      });
      done.add_css_class('compact');
      const close = new Gtk.Button({ label: _('Done'), halign: Gtk.Align.CENTER });
      close.add_css_class('suggested-action');
      close.add_css_class('pill');
      close.connect('clicked', () => dialog.close());
      done.set_child(close);
      stack.add_named(done, name);
      stack.set_visible_child_name(name);
      return;
    }
    const ticked = new Set<string>();
    const column = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 18,
      marginTop: 12,
      marginBottom: 18,
      marginStart: 12,
      marginEnd: 12,
    });
    const intro = new Gtk.Label({
      label: _('These people have similar names. Are they the same person?'),
      wrap: true,
      xalign: 0,
    });
    intro.add_css_class('dim-label');
    const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE });
    list.add_css_class('boxed-list');
    const mergeButton = new Gtk.Button({ label: _('Merge'), hexpand: true });
    mergeButton.add_css_class('suggested-action');
    mergeButton.add_css_class('pill');
    const skipButton = new Gtk.Button({ label: _('Skip'), hexpand: true });
    skipButton.add_css_class('pill');
    const buttons = new Gtk.Box({ spacing: 12, homogeneous: true });
    buttons.append(skipButton);
    buttons.append(mergeButton);
    const sync = () => mergeButton.set_sensitive(answerSet(set, ticked).merge.length > 0);
    for (const entry of set.entries) list.append(personRow(entry, labels, ticked, sync));
    column.append(intro);
    column.append(list);
    column.append(buttons);
    const scroller = new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true });
    scroller.set_child(column);
    stack.add_named(scroller, name);
    stack.set_visible_child_name(name);
    header.set_title_widget(
      new Adw.WindowTitle({ title: _('Merge contacts'), subtitle: `${step + 1} / ${sets.length}` }),
    );
    sync();
    skipButton.connect('clicked', () => {
      tools.decline(answerSet(set, ticked).decline);
      advance();
    });
    mergeButton.connect('clicked', () => {
      const answer = answerSet(set, ticked);
      tools.merge(answer.merge);
      tools.decline(answer.decline);
      merged += 1;
      advance();
    });
  };
  show();
  dialog.connect('closed', () => tools.closed());
  dialog.present(parent);
}
