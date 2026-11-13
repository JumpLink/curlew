/**
 * The sidebar: a slim header (search and menu), filter chips, and one list of every conversation
 * in collapsible sections (docs/design/ui.md). Widgets only; what is shown is
 * `conversation-list-model.ts`.
 *
 * Plain Adwaita: an avatar with a small badge for the protocol, no stylesheet.
 */

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import type Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _, _n, fmt } from '@curlew/protocol';

import { configPath } from '@curlew/store';
import { chatOnly } from '../core/platform.ts';
import { loadConfig } from '../core/config.ts';
import type { SearchScope } from '../core/lib/search-scope.ts';
import { hiddenMailNote } from './email-chat-model.ts';
import { showPicture } from './contact-picture.ts';
import {
  type ListEntry,
  type ListFilter,
  type Section,
  MIN_TEXT_QUERY,
  accountChoices,
  dropDeselectedAccounts,
  backendChoices,
  buildSections,
  initials,
  listSubtitle,
  entryCarrier,
  protocolIcon,
  protocolLabel,
  shortTime,
  unreadText,
  unreadTier,
} from './conversation-list-model.ts';
import { mergeSummary, prunePicks, selectionTitle, selectionTools, togglePick } from './selection-model.ts';

/** What the selection mode's bottom bar does; the window writes the config and refreshes. */
export interface PeopleTools {
  merge(personIds: string[]): void;
  unmerge(personIds: string[]): void;
  /** Open the merge assistant, from the banner. */
  review(): void;
  /** Open the picker for a conversation with someone who has none yet. */
  compose(): void;
  /** Conversation id → a line of message text that contains `text`; read from the index. */
  searchText(text: string): ReadonlyMap<string, string>;
  /** The saved search scope, read once when the list is built. */
  searchScope(): SearchScope;
  /** The person picked another scope; the window saves it. */
  setSearchScope(scope: SearchScope): void;
}

export interface ConversationList {
  page: Adw.NavigationPage;
  /** Replace the entries; the selection and the filters stay. */
  setEntries(entries: ListEntry[], accountLabels: Map<string, string>): void;
  /** How many sets of similar people the assistant has to offer; the banner shows while it is above 0. */
  setSuggestions(count: number): void;
  /** Switch one protocol chip on, as a click would. */
  chooseProtocol(backend: string): void;
  /** Open the search with this text and optionally the scope menu (the screenshot hook). */
  showSearch(text: string, openScope: boolean): void;
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
    iconName: protocolIcon(entryCarrier(entry)),
    pixelSize: 16,
    hexpand: true,
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
  });
  badge.append(icon);
  const overlay = new Gtk.Overlay();
  overlay.set_child(avatar);
  overlay.add_overlay(badge);
  overlay.set_tooltip_text(protocolLabel(entryCarrier(entry)));
  showPicture(avatar, entry);
  return overlay;
}

interface EntryRow {
  row: Gtk.ListBoxRow;
  /** The check circle of the selection mode; hidden outside it. */
  check: Gtk.CheckButton;
}

function entryRow(
  entry: ListEntry,
  accountLabels: Map<string, string>,
  picking: boolean,
  picked: boolean,
): EntryRow {
  const title = new Gtk.Label({ label: entry.title, xalign: 0, ellipsize: 3, hexpand: true });
  // Bold while unread; the HIG's own style class, so dark mode and accents stay Adwaita's.
  if (unreadTier(entry) === 'count') title.add_css_class('heading');
  const time = new Gtk.Label({ label: shortTime(entry.lastMessageAt), xalign: 1 });
  time.add_css_class('caption');
  time.add_css_class('dim-label');
  const titleLine = new Gtk.Box({ spacing: 6 });
  titleLine.append(title);
  titleLine.append(time);

  // The protocol is the badge on the avatar, not text. The line shows the newest message; a row
  // with none yet names the account instead, which otherwise only the tooltip of the row carries.
  const account = listSubtitle(entry, accountLabels);
  const subtitle = new Gtk.Label({
    label: entry.preview ?? account,
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
    count.add_css_class('caption-heading');
    count.add_css_class('accent');
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
  // The row itself takes the click; the circle only shows the state (Adwaita's round check).
  const check = new Gtk.CheckButton({ active: picked, visible: picking, canTarget: false, focusable: false });
  check.add_css_class('selection-mode');
  box.append(check);
  box.append(badgedAvatar(entry));
  box.append(text);
  const row = new Gtk.ListBoxRow();
  row.set_child(box);
  if (entry.preview !== undefined) row.set_tooltip_text(account);
  return { row, check };
}

function sectionRow(section: Section, collapsed: boolean): Gtk.ListBoxRow {
  const box = new Gtk.Box({ spacing: 8, marginTop: 6, marginBottom: 6, marginStart: 12, marginEnd: 12 });
  const title = new Gtk.Label({ label: section.title, xalign: 0, hexpand: true });
  // A step below the row titles, so the sections read as labels and the people as content.
  title.add_css_class('caption-heading');
  title.add_css_class('dim-label');
  box.append(title);
  // Collapsed, the section still says it holds something unread (Fractal's section_row).
  if (collapsed && section.unread > 0) {
    const count = new Gtk.Label({ label: unreadText(section.unread) });
    count.add_css_class('numeric');
    count.add_css_class('dim-label');
    box.append(count);
  }
  const chevron = new Gtk.Image({
    iconName: collapsed ? 'pan-end-symbolic' : 'pan-down-symbolic',
    pixelSize: 16,
  });
  chevron.add_css_class('dim-label');
  box.append(chevron);
  const row = new Gtk.ListBoxRow({ selectable: false });
  row.set_child(box);
  return row;
}

export function createConversationList(
  menu: Gio.Menu,
  onSelect: (entry: ListEntry) => void,
  onAddAccount: () => void,
  people: PeopleTools,
): ConversationList {
  let entries: ListEntry[] = [];
  let labels = new Map<string, string>();
  let selectedId: string | null = null;
  const collapsed = new Set<string>();
  const backends = new Set<string>();
  const accounts = new Map<string, Set<string>>();
  let query = '';
  let hits: ReadonlyMap<string, string> = new Map();
  let scope: SearchScope = people.searchScope();
  const refs = new Map<Gtk.ListBoxRow, RowRef>();
  const checks = new Map<string, { row: Gtk.ListBoxRow; check: Gtk.CheckButton }>();
  let picking = false;
  const picked = new Set<string>();

  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.SINGLE });
  list.add_css_class('navigation-sidebar');
  const scroller = new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true });
  scroller.set_child(list);
  const empty = new Adw.StatusPage({ iconName: 'view-dual-symbolic', vexpand: true });
  empty.add_css_class('compact');
  const addButton = new Gtk.Button({ label: _('Add an account'), marginTop: 12 });
  addButton.add_css_class('suggested-action');
  addButton.connect('clicked', () => onAddAccount());
  empty.set_child(addButton);
  const stack = new Gtk.Stack();
  stack.add_named(scroller, 'list');
  stack.add_named(empty, 'empty');

  const search = new Gtk.SearchEntry({ placeholderText: _('Search conversations'), hexpand: true });
  search.update_property([Gtk.AccessibleProperty.LABEL], [_('Search conversations')]);

  // The scope sits next to the entry as a menu of radio items; Adwaita styles it, no custom CSS.
  const scopeLabels: Record<SearchScope, () => string> = {
    all: () => _('Everything'),
    names: () => _('Names and numbers'),
    messages: () => _('Messages'),
  };
  const scopeButton = new Gtk.MenuButton({
    iconName: 'view-list-symbolic',
    tooltipText: _('Search in'),
    valign: Gtk.Align.CENTER,
  });
  scopeButton.add_css_class('flat');
  scopeButton.update_property([Gtk.AccessibleProperty.LABEL], [_('Search in')]);
  const scopePopover = new Gtk.Popover({ autohide: true });
  const scopeBox = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    marginStart: 6,
    marginEnd: 6,
    marginTop: 6,
    marginBottom: 6,
  });
  scopePopover.set_child(scopeBox);
  scopeButton.set_popover(scopePopover);
  const searchRow = new Gtk.Box({ spacing: 6 });
  searchRow.append(search);
  searchRow.append(scopeButton);
  const searchBar = new Gtk.SearchBar({ child: searchRow });
  searchBar.connect_entry(search);

  // Filters live in a popover instead of a row of chips, so a long account or protocol
  // list cannot push the conversation list down or wrap across several lines.
  const filterButton = new Gtk.MenuButton({
    iconName: 'view-filter-symbolic',
    tooltipText: _('Filter conversations'),
  });
  const filterPopover = new Gtk.Popover({ autohide: true });
  filterButton.set_popover(filterPopover);
  const filterBox = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 6,
    marginStart: 12,
    marginEnd: 12,
    marginTop: 8,
    marginBottom: 8,
  });
  filterPopover.set_child(filterBox);

  const activeAccountCount = (): number => [...accounts.values()].reduce((n, set) => n + set.size, 0);
  const activeFilterCount = (): number => backends.size + activeAccountCount();
  const updateFilterButton = () => {
    const n = activeFilterCount();
    filterButton.set_label(n > 0 ? String(n) : '');
    if (n > 0) filterButton.add_css_class('suggested-action');
    else filterButton.remove_css_class('suggested-action');
  };

  const filter = (): ListFilter => ({ backends, accounts, query, hits, scope });

  const research = (): void => {
    hits =
      scope !== 'names' && query.trim().length >= MIN_TEXT_QUERY
        ? people.searchText(query.trim())
        : new Map();
    rebuild();
  };
  let group: Gtk.CheckButton | null = null;
  for (const id of ['all', 'names', 'messages'] as const) {
    const item = new Gtk.CheckButton({ label: scopeLabels[id](), active: id === scope });
    if (group === null) group = item;
    else item.set_group(group);
    item.connect('toggled', () => {
      if (!item.get_active() || scope === id) return;
      scope = id;
      people.setSearchScope(id);
      scopePopover.popdown();
      research();
    });
    scopeBox.append(item);
  }

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
      for (const backend of backendsList) wrap.append(makeToggle(protocolLabel(backend), backends, backend));
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
      for (const account of group.accounts)
        wrap.append(makeToggle(labels.get(account) ?? account, chosen, account));
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

  let rebuildGeneration = 0;
  const FIRST_ROWS = 40;
  const ROWS_PER_IDLE = 40;

  function rebuild(): void {
    list.remove_all();
    refs.clear();
    checks.clear();
    const sections = buildSections(entries, filter());
    if (sections.length === 0) {
      const none = entries.length === 0;
      empty.set_title(none ? _('No conversations yet') : _('No matches'));
      const hidden = !chatOnly() && !loadConfig(configPath()).ui.showAllEmails;
      const synced = _(
        'Conversations appear here after Curlew has synced an account. Run "curlew sync" first.',
      );
      empty.set_description(
        none
          ? hidden
            ? `${synced}\n\n${hiddenMailNote()}`
            : synced
          : _('Nothing fits the search and filters.'),
      );
      addButton.set_visible(none);
      stack.set_visible_child_name('empty');
      return;
    }
    stack.set_visible_child_name('list');
    // Thousands of rows built in one go blocked the main loop for over a second: the first batch
    // is built now, the rest in idle batches that a newer rebuild cancels.
    const queue: Array<() => void> = [];
    for (const section of sections) {
      const isCollapsed = collapsed.has(section.id);
      queue.push(() => {
        const header = sectionRow(section, isCollapsed);
        refs.set(header, { kind: 'section', id: section.id });
        list.append(header);
      });
      if (isCollapsed) continue;
      for (const entry of section.entries) {
        queue.push(() => {
          const { row, check } = entryRow(entry, labels, picking, picked.has(entry.id));
          refs.set(row, { kind: 'entry', entry });
          checks.set(entry.id, { row, check });
          list.append(row);
          if (!picking && entry.id === selectedId) list.select_row(row);
        });
      }
    }
    const generation = ++rebuildGeneration;
    let next = 0;
    const build = (count: number) => {
      const end = Math.min(next + count, queue.length);
      for (; next < end; next++) queue[next]!();
    };
    build(FIRST_ROWS);
    if (next < queue.length)
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (generation !== rebuildGeneration) return GLib.SOURCE_REMOVE;
        build(ROWS_PER_IDLE);
        return next < queue.length ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
      });
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
    if (picking) {
      pick(ref.entry);
      return;
    }
    selectedId = ref.entry.id;
    onSelect(ref.entry);
  });
  search.connect('search-changed', () => {
    query = search.get_text();
    research();
  });

  const searchToggle = new Gtk.ToggleButton({ iconName: 'system-search-symbolic' });
  searchToggle.set_tooltip_text(_('Search'));
  searchToggle.bind_property('active', searchBar, 'search-mode-enabled', GObject.BindingFlags.BIDIRECTIONAL);
  const header = new Adw.HeaderBar();
  const composeButton = new Gtk.Button({
    iconName: 'chat-message-new-symbolic',
    tooltipText: _('New conversation'),
  });
  composeButton.connect('clicked', () => people.compose());
  header.pack_start(composeButton);
  header.pack_start(searchToggle);
  header.pack_start(filterButton);
  header.pack_end(new Gtk.MenuButton({ iconName: 'open-menu-symbolic', menuModel: menu, primary: true }));

  // Selection mode swaps the whole header for one that only counts and cancels (Files, Fractal).
  const pickTitle = new Adw.WindowTitle({ title: '' });
  const pickHeader = new Adw.HeaderBar({ showEndTitleButtons: false, titleWidget: pickTitle });
  const cancel = new Gtk.Button({ label: _('Cancel') });
  pickHeader.pack_start(cancel);
  const bars = new Gtk.Stack({ vhomogeneous: false });
  bars.add_named(header, 'normal');
  bars.add_named(pickHeader, 'picking');

  const mergeButton = new Gtk.Button({ label: _('Merge') });
  mergeButton.add_css_class('suggested-action');
  const unmergeButton = new Gtk.Button({ label: _('Separate') });
  const tools = new Gtk.Box({ spacing: 12, halign: Gtk.Align.CENTER });
  tools.append(unmergeButton);
  tools.append(mergeButton);
  const actions = new Gtk.ActionBar();
  actions.set_center_widget(tools);

  const picks = (): ListEntry[] => entries.filter((entry) => picked.has(entry.id));
  const refreshTools = () => {
    const state = selectionTools(picks());
    pickTitle.set_title(selectionTitle(picked.size));
    mergeButton.set_sensitive(state.canMerge);
    unmergeButton.set_visible(state.canUnmerge);
  };
  const setPicking = (on: boolean) => {
    picking = on;
    if (!on) picked.clear();
    // Single selection marks the open conversation; a selection mode has no such mark.
    list.set_selection_mode(on ? Gtk.SelectionMode.NONE : Gtk.SelectionMode.SINGLE);
    for (const [id, { row, check }] of checks) {
      check.set_visible(on);
      check.set_active(picked.has(id));
      if (!on && id === selectedId) list.select_row(row);
    }
    bars.set_visible_child_name(on ? 'picking' : 'normal');
    toolbar.set_reveal_bottom_bars(on);
    refreshTools();
  };
  function pick(entry: ListEntry): void {
    togglePick(picked, entry.id);
    const shown = checks.get(entry.id);
    if (shown) shown.check.set_active(picked.has(entry.id));
    refreshTools();
  }
  const rowAt = (y: number): ListEntry | null => {
    const ref = refs.get(list.get_row_at_y(Math.round(y)) as Gtk.ListBoxRow);
    return ref?.kind === 'entry' ? ref.entry : null;
  };
  cancel.connect('clicked', () => setPicking(false));

  // Long press (touch), right click and Ctrl+click (pointer) start the mode on the row they hit.
  // Claiming the sequence keeps the list's own click from activating the same row afterwards.
  const longPress = new Gtk.GestureLongPress({ propagationPhase: Gtk.PropagationPhase.CAPTURE });
  longPress.connect('pressed', (gesture: Gtk.GestureLongPress, _x: number, y: number) => {
    const entry = rowAt(y);
    if (!entry || picking) return;
    gesture.set_state(Gtk.EventSequenceState.CLAIMED);
    setPicking(true);
    pick(entry);
  });
  const click = new Gtk.GestureClick({ button: 0, propagationPhase: Gtk.PropagationPhase.CAPTURE });
  click.connect('pressed', (gesture: Gtk.GestureClick, _n: number, _x: number, y: number) => {
    const entry = rowAt(y);
    if (!entry) return;
    const ctrl = (gesture.get_current_event_state() & Gdk.ModifierType.CONTROL_MASK) !== 0;
    const button = gesture.get_current_button();
    if (button !== Gdk.BUTTON_SECONDARY && !(button === Gdk.BUTTON_PRIMARY && ctrl)) return;
    gesture.set_state(Gtk.EventSequenceState.CLAIMED);
    if (!picking) setPicking(true);
    pick(entry);
  });
  list.add_controller(longPress);
  list.add_controller(click);
  const keys = new Gtk.EventControllerKey({ propagationPhase: Gtk.PropagationPhase.CAPTURE });
  keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number) => {
    if (!picking || keyval !== Gdk.KEY_Escape) return false;
    setPicking(false);
    return true;
  });

  mergeButton.connect('clicked', () => {
    const chosen = picks();
    const state = selectionTools(chosen);
    if (!state.canMerge) return;
    const dialog = new Adw.AlertDialog({
      heading: _('Merge these people?'),
      body: `${mergeSummary(chosen).join('\n')}\n\n${_('Their chats become one conversation. Nothing is deleted, and you can separate them again.')}`,
    });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('merge', _('Merge'));
    dialog.set_response_appearance('merge', Adw.ResponseAppearance.SUGGESTED);
    dialog.set_default_response('merge');
    dialog.set_close_response('cancel');
    dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
      if (response !== 'merge') return;
      setPicking(false);
      people.merge(state.personIds);
    });
    dialog.present(page);
  });
  unmergeButton.connect('clicked', () => {
    const state = selectionTools(picks());
    setPicking(false);
    people.unmerge(state.personIds);
  });

  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(bars);
  toolbar.add_top_bar(searchBar);
  toolbar.add_bottom_bar(actions);
  toolbar.set_reveal_bottom_bars(false);
  // A quiet banner above the list while the assistant has something to offer.
  const banner = new Adw.Banner({ buttonLabel: _('Review'), revealed: false });
  banner.connect('button-clicked', () => people.review());
  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  stack.set_vexpand(true);
  content.append(banner);
  content.append(stack);
  toolbar.set_content(content);
  const page = new Adw.NavigationPage({ title: _('Conversations'), tag: 'list' });
  page.set_child(toolbar);
  page.add_controller(keys);
  searchBar.set_key_capture_widget(page);

  return {
    page,
    setEntries(next, accountLabels) {
      entries = next;
      labels = accountLabels;
      // A filter whose choice vanished (an account removed) must not hide everything.
      for (const key of backends) if (!entries.some((e) => e.backend === key)) backends.delete(key);
      for (const [backend, chosen] of accounts)
        for (const key of chosen)
          if (!entries.some((e) => e.backend === backend && e.accountId === key)) chosen.delete(key);
      prunePicks(picked, entries);
      rebuildFilters();
      rebuild();
      if (picking) refreshTools();
    },
    setSuggestions(count) {
      banner.set_title(
        fmt(_n('{count} possible duplicate', '{count} possible duplicates', count), { count }),
      );
      banner.set_revealed(count > 0);
    },
    showSearch(text, openScope) {
      searchToggle.set_active(true);
      search.set_text(text);
      if (openScope) scopeButton.popup();
    },
    chooseProtocol(backend) {
      if (!entries.some((e) => e.backend === backend)) return;
      backends.add(backend);
      rebuildFilters();
      rebuild();
    },
  };
}
