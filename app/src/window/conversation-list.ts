/**
 * The sidebar: a slim header (search and menu), filter chips, and one list of every conversation
 * in collapsible sections (docs/design/ui.md). Widgets only; what is shown is
 * `conversation-list-model.ts`.
 *
 * Plain Adwaita: an avatar with a small badge for the protocol, no stylesheet.
 */

import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject?version=2.0';
import type Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';

import {
  type ListEntry,
  type ListFilter,
  type Section,
  accountChoices,
  backendChoices,
  buildSections,
  initials,
  protocolIcon,
  protocolLabel,
  shortTime,
  unreadText,
  unreadTier,
} from './conversation-list-model.ts';

export interface ConversationList {
  page: Adw.NavigationPage;
  /** Replace the entries; the selection and the filters stay. */
  setEntries(entries: ListEntry[], accountLabels: Map<string, string>): void;
}

type RowRef = { kind: 'section'; id: string } | { kind: 'entry'; entry: ListEntry };

function badgedAvatar(entry: ListEntry): Gtk.Widget {
  const avatar = new Adw.Avatar({ size: 40, text: entry.title, showInitials: initials(entry.title) !== '' });
  const badge = new Gtk.Image({ iconName: protocolIcon(entry.backend), pixelSize: 16 });
  badge.add_css_class('osd');
  badge.add_css_class('circular');
  badge.set_halign(Gtk.Align.END);
  badge.set_valign(Gtk.Align.END);
  const overlay = new Gtk.Overlay();
  overlay.set_child(avatar);
  overlay.add_overlay(badge);
  overlay.set_tooltip_text(protocolLabel(entry.backend));
  return overlay;
}

function entryRow(entry: ListEntry, accountLabel: string | undefined): Gtk.ListBoxRow {
  const title = new Gtk.Label({ label: entry.title, xalign: 0, ellipsize: 3, hexpand: true });
  // Bold while unread; the HIG's own style class, so dark mode and accents stay Adwaita's.
  if (unreadTier(entry) === 'count') title.add_css_class('heading');
  const time = new Gtk.Label({ label: shortTime(entry.lastMessageAt), xalign: 1 });
  time.add_css_class('caption');
  time.add_css_class('dim-label');
  const titleLine = new Gtk.Box({ spacing: 6 });
  titleLine.append(title);
  titleLine.append(time);

  // The protocol is the badge on the avatar, not text. There is no stored preview of the last
  // message yet (docs/design/ui.md), so the line names the account.
  const subtitle = new Gtk.Label({
    label: accountLabel ?? entry.accountId,
    xalign: 0,
    ellipsize: 3,
    hexpand: true,
  });
  subtitle.add_css_class('caption');
  subtitle.add_css_class('dim-label');
  const subtitleLine = new Gtk.Box({ spacing: 6 });
  subtitleLine.append(subtitle);
  if (unreadTier(entry) === 'count') {
    const count = new Gtk.Label({ label: unreadText(entry.unread), valign: Gtk.Align.CENTER });
    count.add_css_class('numeric');
    count.add_css_class('dim-label');
    subtitleLine.append(count);
  }
  const text = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    valign: Gtk.Align.CENTER,
    hexpand: true,
  });
  text.append(titleLine);
  text.append(subtitleLine);

  const box = new Gtk.Box({
    spacing: 12,
    marginTop: 8,
    marginBottom: 8,
    marginStart: 12,
    marginEnd: 12,
  });
  box.append(badgedAvatar(entry));
  box.append(text);
  const row = new Gtk.ListBoxRow();
  row.set_child(box);
  return row;
}

function sectionRow(section: Section, collapsed: boolean): Gtk.ListBoxRow {
  const box = new Gtk.Box({ spacing: 8, marginTop: 6, marginBottom: 6, marginStart: 12, marginEnd: 12 });
  const title = new Gtk.Label({ label: section.title, xalign: 0, hexpand: true });
  title.add_css_class('heading');
  box.append(title);
  // Collapsed, the section still says it holds something unread (Fractal's section_row).
  if (collapsed && section.unread > 0) {
    const count = new Gtk.Label({ label: unreadText(section.unread) });
    count.add_css_class('numeric');
    count.add_css_class('dim-label');
    box.append(count);
  }
  box.append(
    new Gtk.Image({ iconName: collapsed ? 'pan-end-symbolic' : 'pan-down-symbolic', pixelSize: 16 }),
  );
  const row = new Gtk.ListBoxRow({ selectable: false });
  row.set_child(box);
  return row;
}

export function createConversationList(
  menu: Gio.Menu,
  onSelect: (entry: ListEntry) => void,
): ConversationList {
  let entries: ListEntry[] = [];
  let labels = new Map<string, string>();
  let selectedId: string | null = null;
  const collapsed = new Set<string>();
  const backends = new Set<string>();
  const accounts = new Set<string>();
  let query = '';
  const refs = new Map<Gtk.ListBoxRow, RowRef>();

  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.SINGLE });
  list.add_css_class('navigation-sidebar');
  const scroller = new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true });
  scroller.set_child(list);
  const empty = new Adw.StatusPage({ iconName: 'view-dual-symbolic', vexpand: true });
  empty.add_css_class('compact');
  const stack = new Gtk.Stack();
  stack.add_named(scroller, 'list');
  stack.add_named(empty, 'empty');

  const chips = new Adw.WrapBox({
    childSpacing: 6,
    lineSpacing: 6,
    marginStart: 12,
    marginEnd: 12,
    marginBottom: 6,
  });
  const search = new Gtk.SearchEntry({ placeholderText: _('Search conversations'), hexpand: true });
  const searchBar = new Gtk.SearchBar({ child: search });
  searchBar.connect_entry(search);

  const filter = (): ListFilter => ({ backends, accounts, query });

  const chip = (label: string, set: Set<string>, key: string): Gtk.ToggleButton => {
    const button = new Gtk.ToggleButton({ label, active: set.has(key) });
    button.add_css_class('flat');
    button.add_css_class('caption');
    button.connect('toggled', () => {
      if (button.get_active()) set.add(key);
      else set.delete(key);
      rebuild();
    });
    return button;
  };

  function rebuildChips(): void {
    let child = chips.get_first_child();
    while (child) {
      const next = child.get_next_sibling();
      chips.remove(child);
      child = next;
    }
    for (const backend of backendChoices(entries))
      chips.append(chip(protocolLabel(backend), backends, backend));
    for (const account of accountChoices(entries, backends))
      chips.append(chip(labels.get(account) ?? account, accounts, account));
    chips.set_visible(chips.get_first_child() !== null);
  }

  function rebuild(): void {
    list.remove_all();
    refs.clear();
    const sections = buildSections(entries, filter());
    if (sections.length === 0) {
      const none = entries.length === 0;
      empty.set_title(none ? _('No conversations yet') : _('No matches'));
      empty.set_description(
        none
          ? _('Conversations appear here after Curlew has synced an account. Run "curlew sync" first.')
          : _('Nothing fits the search and filters.'),
      );
      stack.set_visible_child_name('empty');
      return;
    }
    stack.set_visible_child_name('list');
    for (const section of sections) {
      const isCollapsed = collapsed.has(section.id);
      const header = sectionRow(section, isCollapsed);
      refs.set(header, { kind: 'section', id: section.id });
      list.append(header);
      if (isCollapsed) continue;
      for (const entry of section.entries) {
        const row = entryRow(entry, labels.get(entry.accountId));
        refs.set(row, { kind: 'entry', entry });
        list.append(row);
        if (entry.id === selectedId) list.select_row(row);
      }
    }
  }

  list.connect('row-activated', (_list: Gtk.ListBox, row: Gtk.ListBoxRow) => {
    const ref = refs.get(row);
    if (!ref) return;
    if (ref.kind === 'section') {
      if (collapsed.has(ref.id)) collapsed.delete(ref.id);
      else collapsed.add(ref.id);
      rebuild();
      return;
    }
    selectedId = ref.entry.id;
    onSelect(ref.entry);
  });
  search.connect('search-changed', () => {
    query = search.get_text();
    rebuild();
  });

  const searchToggle = new Gtk.ToggleButton({ iconName: 'system-search-symbolic' });
  searchToggle.set_tooltip_text(_('Search'));
  searchToggle.bind_property('active', searchBar, 'search-mode-enabled', GObject.BindingFlags.BIDIRECTIONAL);
  const header = new Adw.HeaderBar();
  header.pack_start(searchToggle);
  header.pack_end(new Gtk.MenuButton({ iconName: 'open-menu-symbolic', menuModel: menu, primary: true }));

  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(header);
  toolbar.add_top_bar(searchBar);
  toolbar.add_top_bar(chips);
  toolbar.set_content(stack);
  const page = new Adw.NavigationPage({ title: _('Conversations'), tag: 'list' });
  page.set_child(toolbar);
  searchBar.set_key_capture_widget(page);

  return {
    page,
    setEntries(next, accountLabels) {
      entries = next;
      labels = accountLabels;
      // A filter whose choice vanished (an account removed) must not hide everything.
      for (const key of backends) if (!entries.some((e) => e.backend === key)) backends.delete(key);
      for (const key of accounts) if (!entries.some((e) => e.accountId === key)) accounts.delete(key);
      rebuildChips();
      rebuild();
    },
  };
}
