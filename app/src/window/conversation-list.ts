/**
 * The sidebar: a slim header (search and menu), filter chips, and one list of every conversation
 * in collapsible sections (docs/design/ui.md). Widgets only; what is shown is
 * `conversation-list-model.ts`.
 *
 * Plain Adwaita: an avatar with a small badge for the protocol, no stylesheet.
 */

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import type Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';

import {
  type ListEntry,
  type ListFilter,
  type Section,
  accountChoices,
  dropDeselectedAccounts,
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
  /** Switch one protocol chip on, as a click would. */
  chooseProtocol(backend: string): void;
}

type RowRef = { kind: 'section'; id: string } | { kind: 'entry'; entry: ListEntry };

const AVATAR_SIZE = 40;
const BADGE_SIZE = 22;
/** Room the badge hangs in, so it sits on the avatar's rim and the initials stay readable. */
const BADGE_OVERHANG = 6;

function badgedAvatar(entry: ListEntry): Gtk.Widget {
  const avatar = new Adw.Avatar({
    size: AVATAR_SIZE,
    text: entry.title,
    showInitials: initials(entry.title) !== '',
    marginEnd: BADGE_OVERHANG,
    marginBottom: BADGE_OVERHANG,
  });
  // A solid backdrop in the theme's own card colour: it contrasts with the avatar in light and dark
  // mode, and its 12 px radius on a 22 px box clamps to half the width, so it draws a circle.
  const badge = new Gtk.Box({
    widthRequest: BADGE_SIZE,
    heightRequest: BADGE_SIZE,
    halign: Gtk.Align.END,
    valign: Gtk.Align.END,
  });
  badge.add_css_class('card');
  badge.add_css_class('view');
  const icon = new Gtk.Image({
    iconName: protocolIcon(entry.backend),
    pixelSize: 16,
    hexpand: true,
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
  });
  badge.append(icon);
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
  const accounts = new Map<string, Set<string>>();
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

  const search = new Gtk.SearchEntry({ placeholderText: _('Search conversations'), hexpand: true });
  const searchBar = new Gtk.SearchBar({ child: search });
  searchBar.connect_entry(search);

  // Filters live in a popover instead of a row of chips, so a long account or protocol
  // list cannot push the conversation list down or wrap across several lines.
  const filterButton = new Gtk.MenuButton({ iconName: 'view-filter-symbolic', tooltipText: _('Filter conversations') });
  const filterPopover = new Gtk.Popover({ autohide: true });
  filterButton.set_popover(filterPopover);
  const filterBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, marginStart: 12, marginEnd: 12, marginTop: 8, marginBottom: 8 });
  filterPopover.set_child(filterBox);

  const activeAccountCount = (): number => [...accounts.values()].reduce((n, set) => n + set.size, 0);
  const activeFilterCount = (): number => backends.size + activeAccountCount();
  const updateFilterButton = () => {
    const n = activeFilterCount();
    filterButton.set_label(n > 0 ? String(n) : '');
    if (n > 0) filterButton.add_css_class('suggested-action');
    else filterButton.remove_css_class('suggested-action');
  };

  const filter = (): ListFilter => ({ backends, accounts, query });

  function makeToggle(label: string, set: Set<string>, key: string): Gtk.ToggleButton {
    const button = new Gtk.ToggleButton({ label, active: set.has(key) });
    button.add_css_class('caption-heading');
    const paint = () => {
      if (button.get_active()) button.add_css_class('suggested-action');
      else button.remove_css_class('suggested-action');
    };
    paint();
    button.connect('toggled', () => {
      if (button.get_active()) set.add(key);
      else set.delete(key);
      // A protocol that is deselected takes its account choices with it.
      if (set === backends) {
        dropDeselectedAccounts(accounts, backends);
        // The account chips follow the protocols; rebuilt after this handler, not inside it.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
          rebuildFilters();
          return GLib.SOURCE_REMOVE;
        });
      }
      paint();
      updateFilterButton();
      rebuild();
    });
    return button;
  }

  function rebuildFilters(): void {
    // Rebuild the popover contents from the current entries.
    let child = filterBox.get_first_child();
    while (child) {
      const next = child.get_next_sibling();
      filterBox.remove(child);
      child = next;
    }

    const backendsList = backendChoices(entries);
    if (backendsList.length > 0) {
      const header = new Gtk.Label({ label: _('Protocols'), xalign: 0 });
      header.add_css_class('heading');
      header.add_css_class('caption');
      filterBox.append(header);
      const wrap = new Adw.WrapBox({ childSpacing: 6, lineSpacing: 6 });
      for (const backend of backendsList)
        wrap.append(makeToggle(protocolLabel(backend), backends, backend));
      filterBox.append(wrap);
    }

    const accountGroups = accountChoices(entries, backends);
    for (const group of accountGroups) {
      const header = new Gtk.Label({ label: protocolLabel(group.backend), xalign: 0 });
      header.add_css_class('heading');
      header.add_css_class('caption');
      filterBox.append(header);
      let chosen = accounts.get(group.backend);
      if (!chosen) accounts.set(group.backend, (chosen = new Set()));
      const wrap = new Adw.WrapBox({ childSpacing: 6, lineSpacing: 6 });
      for (const account of group.accounts) wrap.append(makeToggle(labels.get(account) ?? account, chosen, account));
      filterBox.append(wrap);
    }

    const clear = new Gtk.Button({ label: _('Clear filters') });
    clear.add_css_class('flat');
    clear.connect('clicked', () => {
      backends.clear();
      accounts.clear();
      rebuildFilters();
      rebuild();
    });
    clear.set_sensitive(activeFilterCount() > 0);
    filterBox.append(clear);

    filterButton.set_visible(backendsList.length > 0);
    updateFilterButton();
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
  header.pack_start(filterButton);
  header.pack_end(new Gtk.MenuButton({ iconName: 'open-menu-symbolic', menuModel: menu, primary: true }));

  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(header);
  toolbar.add_top_bar(searchBar);
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
      for (const [backend, chosen] of accounts)
        for (const key of chosen) if (!entries.some((e) => e.backend === backend && e.accountId === key)) chosen.delete(key);
      rebuildFilters();
      rebuild();
    },
    chooseProtocol(backend) {
      if (!entries.some((e) => e.backend === backend)) return;
      backends.add(backend);
      rebuildFilters();
      rebuild();
    },
  };
}
