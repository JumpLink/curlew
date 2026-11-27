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
  entryRowKey,
  sectionRowKey,
  avatarSeed,
  initials,
  listSubtitle,
  entryCarrier,
  protocolIcon,
  protocolLabel,
  shortTime,
  muteTooltip,
  favouriteLabel,
  muteUntil,
  type MuteChoice,
  unreadLabel,
  unreadText,
  unreadTier,
} from './conversation-list-model.ts';
import { mergeSummary, prunePicks, selectionTitle, selectionTools, togglePick } from './selection-model.ts';
import { runChunked, type CancelWork } from './idle-work.ts';
import { diffKeys } from './list-diff-model.ts';
import { createSkeletonRows } from './skeleton-rows.ts';
import { timed } from './stall-probe.ts';

/** What the selection mode's bottom bar does; the window writes the config and refreshes. */
export interface PeopleTools {
  merge(personIds: string[]): void;
  unmerge(personIds: string[]): void;
  /** Mark the picked conversations read or unread; the window writes the index and refreshes. */
  setRead(entries: ListEntry[], read: boolean): void;
  /** Mute (`until` an instant, or null = until unmuted) or unmute the picked conversations on every network. */
  setMute(entries: ListEntry[], mute: { muted: boolean; until: string | null }): void;
  /** Star or unstar the picked conversations (every thread of a merged contact). */
  setFavourite(entries: ListEntry[], favourite: boolean): void;
  /** Open the merge assistant, from the banner. */
  review(): void;
  /** Open the picker for a conversation with someone who has none yet. */
  compose(): void;
  /** Conversation id → a line of message text that contains `text`; read from the index. */
  searchText(text: string): ReadonlyMap<string, string>;
  /** The message text now being searched ('' = none), so an open conversation can follow it. */
  searchChanged(text: string): void;
  /** The saved search scope, read once when the list is built. */
  searchScope(): SearchScope;
  /** The person picked another scope; the window saves it. */
  setSearchScope(scope: SearchScope): void;
}

export interface ConversationList {
  page: Adw.NavigationPage;
  /** Replace the entries; the selection and the filters stay. */
  setEntries(entries: ListEntry[], accountLabels: Map<string, string>): void;
  /**
   * A read of the index is running, or has stopped. Before the first one answers this is the
   * placeholder rows; after it a marker in the header, with the rows left alone (#541).
   */
  setLoading(on: boolean): void;
  /** How many sets of similar people the assistant has to offer; the banner shows while it is above 0. */
  setSuggestions(count: number): void;
  /** Switch one protocol chip on, as a click would. */
  chooseProtocol(backend: string): void;
  /** Open the search with this text and optionally the scope menu (the screenshot hook). */
  showSearch(text: string, openScope: boolean): void;
  /** Start the selection mode with the first `count` conversations picked (the screenshot hook `CURLEW_WINDOW_SELECT`). */
  pickFirst(count: number): void;
}

type RowRef = { kind: 'section'; id: string } | { kind: 'entry'; entry: ListEntry };

/**
 * A row a rebuild means to show, flat in list order.
 *
 * Plain data, not a closure per row: a rebuild plans every row the filters allow but builds only
 * the {@link PAGE} the person can see, and on a large index the planning itself was 15 of the
 * 20 ms a background refresh cost.
 */
type PlannedRow =
  | { kind: 'section'; section: Section; collapsed: boolean }
  | { kind: 'entry'; entry: ListEntry };

/** A row in the list: what it draws ({@link entryRowKey}), and for a conversation its check box. */
interface RowSlot {
  key: string;
  row: Gtk.ListBoxRow;
  /** The conversation the row stands for; null for a section header. */
  id: string | null;
  check: Gtk.CheckButton | null;
}

/**
 * Conversation rows the list holds at once, and how many more a scroll towards the end adds.
 *
 * A `Gtk.ListBox` has no virtualization: every row is a widget, and handing GTK one costs a pass
 * over the rows that are already there. Measured on a synthetic index of 10 500 conversations
 * (`dev/perf.sh`): 0.9 ms at row 2 500, 4.5 ms at row 3 400, 6.9 ms at row 5 900 -- linear in the
 * row count, so filling the whole list is quadratic. That is what burned five hours of CPU in
 * under four and made GNOME offer to kill the window (#501); no amount of slicing fixes it,
 * because the total work itself is the problem.
 *
 * So the list holds a window of rows and grows it while the person scrolls. 40 rows is about four
 * screens at 360 px: inserting one costs GTK well under a tenth of a millisecond there, and a
 * search that changes every row still only rebuilds forty.
 */
const PAGE = 40;

const AVATAR_SIZE = 40;
const BADGE_SIZE = 22;
/** Room the badge hangs in, so it sits on the avatar's rim and the initials stay readable. */
const BADGE_OVERHANG = 6;

function badgedAvatar(entry: ListEntry): Gtk.Widget {
  const avatar = new Adw.Avatar({
    size: AVATAR_SIZE,
    text: avatarSeed(entry),
    // A note to self shows the person icon: its seed is not a name, so it has no initials.
    showInitials: avatarSeed(entry) === entry.title && initials(entry.title) !== '',
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
  const starNote = favouriteLabel(entry);
  if (starNote !== null) {
    const star = new Gtk.Image({ iconName: 'starred-symbolic', valign: Gtk.Align.CENTER });
    star.add_css_class('dim-label');
    star.set_tooltip_text(starNote);
    star.update_property([Gtk.AccessibleProperty.LABEL], [starNote]);
    titleLine.append(star);
  }
  const muteNote = muteTooltip(entry);
  if (muteNote !== null) {
    const bell = new Gtk.Image({ iconName: 'notifications-disabled-symbolic', valign: Gtk.Align.CENTER });
    bell.add_css_class('dim-label');
    bell.set_tooltip_text(muteNote);
    bell.update_property([Gtk.AccessibleProperty.LABEL], [muteNote]);
    titleLine.append(bell);
  }
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
    // Muted: the count stays (the chat is unread) but stops calling; the label says why.
    if (muteNote === null) count.add_css_class('accent');
    else count.add_css_class('dim-label');
    count.update_property([Gtk.AccessibleProperty.LABEL], [unreadLabel(entry)]);
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
  // The Unread group always shows its count: that number is what the group is for.
  if ((collapsed || section.id === 'unread') && section.unread > 0) {
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
  // Mirrors the list's children exactly, in their order: a rebuild is applied one row at a time
  // across main-loop turns and can be cancelled half-way, so this is kept in step with the widget
  // rather than with the plan. One conversation can show in two sections (Unread and People).
  const live: RowSlot[] = [];
  let picking = false;
  const picked = new Set<string>();

  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.SINGLE });
  list.add_css_class('navigation-sidebar');
  const scroller = new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true });
  scroller.set_child(list);
  const vadjust = scroller.get_vadjustment();
  vadjust.connect('value-changed', () => extend());
  vadjust.connect('changed', () => extend());
  const empty = new Adw.StatusPage({ iconName: 'view-dual-symbolic', vexpand: true });
  empty.add_css_class('compact');
  const addButton = new Gtk.Button({ label: _('Add an account'), marginTop: 12 });
  addButton.add_css_class('suggested-action');
  addButton.connect('clicked', () => onAddAccount());
  empty.set_child(addButton);
  const stack = new Gtk.Stack();
  stack.add_named(scroller, 'list');
  stack.add_named(empty, 'empty');
  stack.add_named(createSkeletonRows(), 'loading');
  // Until the first read comes back the list showed "No conversations yet", which on a large index
  // is both wrong and the last thing a person needs to read (#541). Placeholder rows instead.
  stack.set_visible_child_name('loading');
  stack.update_state([Gtk.AccessibleState.BUSY], [true]);
  stack.update_property([Gtk.AccessibleProperty.LABEL], [_('Loading conversations')]);

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
    // A new search is a new list and a new scroll position, so the window of rows starts over:
    // without this, clearing a search after scrolling deep would rebuild every row scrolled past.
    shown = PAGE;
    hits = timed('s text', () =>
      scope !== 'names' && query.trim().length >= MIN_TEXT_QUERY
        ? people.searchText(query.trim())
        : new Map(),
    );
    people.searchChanged(hits.size > 0 ? query.trim() : '');
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

  // The sliced runs filling the list, if any are still going: a new rebuild stops them all before
  // they write into a list they no longer describe. A fill is two runs, one chained on the other,
  // and the second may start while the first is still being set up -- hence a list and not a slot.
  let running: CancelWork[] = [];
  const stop = (): void => {
    const runs = running;
    running = [];
    for (const cancel of runs) cancel();
  };
  const start = (steps: ReadonlyArray<() => void>, done?: () => void): void => {
    running.push(runChunked(steps, done));
  };
  /** The index has been read at least once; until then the list shows placeholder rows. */
  let read = false;
  /** Every row the filters allow, built or not; the first {@link shown} of them are on screen. */
  let planned: PlannedRow[] = [];
  let shown = PAGE;
  /** A build is in flight, so the growing content height is not mistaken for a scroll. */
  let filling = false;

  function rebuild(): void {
    stop();
    // Nothing has been read yet, so there is nothing to say about what is or is not in the index.
    if (!read) return;
    const sections = timed('r sections', () => buildSections(entries, filter()));
    if (sections.length === 0) {
      const none = entries.length === 0;
      empty.set_title(none ? _('No conversations yet') : _('No matches'));
      const hidden = !chatOnly() && !loadConfig(configPath()).ui.showAllEmails;
      const synced = _('Conversations appear here once an account is added and its messages have arrived.');
      empty.set_description(
        none
          ? hidden
            ? `${synced}\n\n${hiddenMailNote()}`
            : synced
          : _('Nothing fits the search and filters.'),
      );
      addButton.set_visible(none);
      // The page is swapped first, so the rows go while they are off screen.
      stack.set_visible_child_name('empty');
      planned = [];
      apply([], []);
      return;
    }
    stack.set_visible_child_name('list');
    const plan: PlannedRow[] = [];
    for (const section of sections) {
      const isCollapsed = collapsed.has(section.id);
      plan.push({ kind: 'section', section, collapsed: isCollapsed });
      if (isCollapsed) continue;
      for (const entry of section.entries) plan.push({ kind: 'entry', entry });
    }
    planned = plan;
    fill();
  }

  /** What the row would draw, so an identical one on screen can stay ({@link diffKeys}). */
  function keyOf(planned: PlannedRow, now: Date): string {
    return planned.kind === 'section'
      ? sectionRowKey(planned.section, planned.collapsed)
      : entryRowKey(planned.entry, labels, picking, picked.has(planned.entry.id), now);
  }

  function buildRow(planned: PlannedRow): RowSlot {
    if (planned.kind === 'section') {
      const header = sectionRow(planned.section, planned.collapsed);
      refs.set(header, { kind: 'section', id: planned.section.id });
      return { key: '', row: header, id: null, check: null };
    }
    const { entry } = planned;
    const { row, check } = entryRow(entry, labels, picking, picked.has(entry.id));
    refs.set(row, { kind: 'entry', entry });
    // The open conversation is marked on its first row, and only while no row holds the mark
    // already: a kept row brings its selection with it.
    if (!picking && entry.id === selectedId && list.get_selected_row() === null) list.select_row(row);
    return { key: '', row, id: entry.id, check };
  }

  /** Put the first {@link shown} planned rows on screen, keeping the ones that already fit. */
  function fill(): void {
    stop();
    const plan = planned.slice(0, shown);
    // One instant for the whole fill: the keys are folded across several turns, and a row whose
    // "4 min ago" was folded a turn later would differ from one folded a turn earlier.
    const now = new Date();
    // Folding a few dozen keys is still more than a frame on a slow machine, so that pass is
    // sliced too and the list is only touched once every key is in.
    const keys: string[] = Array.from({ length: plan.length }, () => '');
    filling = true;
    start(
      plan.map((row, i) => () => {
        keys[i] = keyOf(row, now);
      }),
      () => {
        apply(plan, keys);
      },
    );
  }

  /**
   * Grow the window of rows while the end of the list is in reach.
   *
   * Driven by the scroll position rather than by a timer, so a list nobody scrolls never pays for
   * rows nobody looks at. It also fires on `changed`, which is how the first screens fill: each
   * finished batch makes the content taller, and that is a scroll event too until the list is
   * taller than the two screens of slack below.
   */
  function extend(): void {
    if (filling || shown >= planned.length) return;
    const room = vadjust.get_page_size() * 2;
    if (vadjust.get_value() + vadjust.get_page_size() + room < vadjust.get_upper()) return;
    shown = Math.min(planned.length, shown + PAGE);
    fill();
  }

  /**
   * Make the list show `plan`, keeping every row that already draws what the plan asks for and
   * building the rest across main-loop turns.
   *
   * Both halves matter. Building thousands of rows in one go blocked the loop for over a second,
   * and throwing thousands away cost another 700 ms in a single atomic GTK pass (#501), so the
   * work is both sliced and, as far as the keys allow, not done at all.
   */
  function apply(plan: ReadonlyArray<PlannedRow>, keys: readonly string[]): void {
    const diff = timed('r diff', () =>
      diffKeys(
        live.map((slot) => slot.key),
        keys,
      ),
    );
    const steps: Array<() => void> = [];
    // Dropped from the bottom up, so the position of every row still to drop stays where the diff
    // said it was; then filled in from the top down, where each insert lands on its final index.
    for (let i = diff.remove.length - 1; i >= 0; i--) {
      const at = diff.remove[i]!;
      steps.push(() => {
        const [slot] = live.splice(at, 1);
        if (slot === undefined) return;
        refs.delete(slot.row);
        list.remove(slot.row);
      });
    }
    for (const at of diff.insert) {
      steps.push(() => {
        const slot = buildRow(plan[at]!);
        slot.key = keys[at]!;
        live.splice(at, 0, slot);
        if (at === live.length - 1) list.append(slot.row);
        else list.insert(slot.row, at);
      });
    }
    start(steps, () => {
      filling = false;
      // The rows just added made the list taller; if the end is still in reach, go on.
      extend();
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
  // Searching is the most expensive rebuild there is -- a full-text query over every message, then
  // the sections folded again -- so it must not run per keystroke. It does not: `search-changed`
  // is `Gtk.SearchEntry`'s own debounced signal (`search-delay`, 150 ms, restarted by each change),
  // so touch-typing a name costs one rebuild and not nine. A second timer here would only add
  // another 150 ms before the person sees an answer.
  search.connect('search-changed', () => {
    query = search.get_text();
    research();
  });
  // A rebuild in flight outlives the widget otherwise, and its next turn would touch a dead list.
  search.connect('destroy', () => stop());

  const searchToggle = new Gtk.ToggleButton({ iconName: 'system-search-symbolic' });
  searchToggle.set_tooltip_text(_('Search'));
  searchToggle.bind_property('active', searchBar, 'search-mode-enabled', GObject.BindingFlags.BIDIRECTIONAL);
  // No title: the sidebar is narrow and the buttons leave no room, so it would truncate on macOS.
  const header = new Adw.HeaderBar({ titleWidget: new Gtk.Box() });
  const composeButton = new Gtk.Button({
    iconName: 'chat-message-new-symbolic',
    tooltipText: _('New conversation'),
  });
  composeButton.connect('clicked', () => people.compose());
  header.pack_start(composeButton);
  header.pack_start(searchToggle);
  header.pack_start(filterButton);
  header.pack_end(new Gtk.MenuButton({ iconName: 'open-menu-symbolic', menuModel: menu, primary: true }));
  // A reload while the list is already up changes a handful of rows: the rows stay as they are,
  // stay clickable, and this says that more may arrive. Deliberately not a banner and not a
  // progress bar over the list -- nothing that moves the rows the person is about to click.
  const busy = new Adw.Spinner({ widthRequest: 16, heightRequest: 16, visible: false });
  busy.update_property([Gtk.AccessibleProperty.LABEL], [_('Refreshing conversations')]);
  header.pack_end(busy);

  // Selection mode swaps the whole header for one that only counts and cancels (Files, Fractal).
  const pickTitle = new Adw.WindowTitle({ title: '' });
  const pickHeader = new Adw.HeaderBar({ showEndTitleButtons: false, titleWidget: pickTitle });
  const cancel = new Gtk.Button({ label: _('Cancel') });
  pickHeader.pack_start(cancel);
  const bars = new Gtk.Stack({ vhomogeneous: false });
  bars.add_named(header, 'normal');
  bars.add_named(pickHeader, 'picking');

  // One flat button per tool: a symbolic icon over a short caption, so four of them fit 360 px.
  const toolButton = (icon: string, caption: string, tooltip: string): Gtk.Button => {
    const content = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 2,
      halign: Gtk.Align.CENTER,
    });
    content.append(new Gtk.Image({ iconName: icon }));
    // The box is homogeneous, so the longest caption ("Zusammenführen") times four would set the
    // sidebar's minimum width; ellipsizing keeps it at icon size, the tooltip carries the full name.
    const label = new Gtk.Label({ label: caption, ellipsize: 3 });
    label.add_css_class('caption');
    content.append(label);
    const button = new Gtk.Button({ child: content, tooltipText: tooltip, hexpand: true });
    button.add_css_class('flat');
    button.update_property([Gtk.AccessibleProperty.LABEL], [tooltip]);
    return button;
  };
  const mergeButton = toolButton('insert-link-symbolic', _('Merge'), _('Merge'));
  mergeButton.remove_css_class('flat');
  mergeButton.add_css_class('suggested-action');
  const unmergeButton = toolButton('edit-cut-symbolic', _('Separate'), _('Separate'));
  const muteBox = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 2,
    halign: Gtk.Align.CENTER,
  });
  muteBox.append(new Gtk.Image({ iconName: 'notifications-disabled-symbolic' }));
  const muteCaption = new Gtk.Label({ label: _('Mute'), ellipsize: 3 });
  muteCaption.add_css_class('caption');
  muteBox.append(muteCaption);
  const muteButton = new Gtk.MenuButton({
    child: muteBox,
    tooltipText: _('Mute'),
    hexpand: true,
    direction: Gtk.ArrowType.UP,
  });
  muteButton.add_css_class('flat');
  muteButton.update_property([Gtk.AccessibleProperty.LABEL], [_('Mute')]);
  const mutePopover = new Gtk.Popover();
  const muteChoices = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  const muteOptions: Array<[MuteChoice, string]> = [
    ['hour', _('For 1 hour')],
    ['day', _('For 1 day')],
    ['week', _('For 1 week')],
    ['always', _('Until I unmute')],
  ];
  for (const [choice, label] of muteOptions) {
    const option = new Gtk.Button({ label });
    option.add_css_class('flat');
    option.connect('clicked', () => {
      mutePopover.popdown();
      setMute({ muted: true, until: muteUntil(choice) });
    });
    muteChoices.append(option);
  }
  mutePopover.set_child(muteChoices);
  muteButton.set_popover(mutePopover);
  const unmuteButton = toolButton('notifications-symbolic', _('Unmute'), _('Unmute'));
  unmuteButton.set_visible(false);
  const starButton = toolButton('non-starred-symbolic', _('Favourite'), _('Add to Favourites'));
  const unstarButton = toolButton('starred-symbolic', _('Unfavourite'), _('Remove from Favourites'));
  unstarButton.set_visible(false);
  const readButton = toolButton('mail-read-symbolic', _('Read'), _('Mark as Read'));
  const unreadButton = toolButton('mail-unread-symbolic', _('Unread'), _('Mark as Unread'));
  const tools = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, homogeneous: true });
  tools.append(readButton);
  tools.append(unreadButton);
  tools.append(starButton);
  tools.append(unstarButton);
  tools.append(muteButton);
  tools.append(unmuteButton);
  tools.append(unmergeButton);
  tools.append(mergeButton);
  const actions = new Gtk.ActionBar();
  actions.set_center_widget(tools);

  const picks = (): ListEntry[] => entries.filter((entry) => picked.has(entry.id));
  const refreshTools = () => {
    const state = selectionTools(picks());
    pickTitle.set_title(selectionTitle(picked.size));
    mergeButton.set_sensitive(state.canMerge);
    mergeButton.set_tooltip_text(state.mergeBlock);
    unmergeButton.set_visible(state.canUnmerge);
    starButton.set_visible(!state.allFavourite);
    starButton.set_sensitive(picked.size > 0);
    unstarButton.set_visible(state.allFavourite);
    muteButton.set_visible(!state.allMuted);
    muteButton.set_sensitive(picked.size > 0);
    unmuteButton.set_visible(state.allMuted);
    readButton.set_sensitive(picked.size > 0);
    unreadButton.set_sensitive(picked.size > 0);
  };
  const setPicking = (on: boolean) => {
    picking = on;
    if (!on) picked.clear();
    // Single selection marks the open conversation; a selection mode has no such mark.
    list.set_selection_mode(on ? Gtk.SelectionMode.NONE : Gtk.SelectionMode.SINGLE);
    for (const slot of live) {
      if (slot.check === null || slot.id === null) continue;
      slot.check.set_visible(on);
      slot.check.set_active(picked.has(slot.id));
    }
    // Leaving the mode gives the open conversation its mark back, on its first row.
    const marked = on ? undefined : live.find((slot) => slot.id === selectedId);
    if (marked) list.select_row(marked.row);
    bars.set_visible_child_name(on ? 'picking' : 'normal');
    toolbar.set_reveal_bottom_bars(on);
    refreshTools();
  };
  function pick(entry: ListEntry): void {
    togglePick(picked, entry.id);
    for (const slot of live) if (slot.id === entry.id) slot.check?.set_active(picked.has(entry.id));
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
  const setRead = (read: boolean) => {
    const chosen = picks();
    setPicking(false);
    people.setRead(chosen, read);
  };
  function setMute(mute: { muted: boolean; until: string | null }): void {
    const chosen = picks();
    setPicking(false);
    people.setMute(chosen, mute);
  }
  const setFavourite = (favourite: boolean) => {
    const chosen = picks();
    setPicking(false);
    people.setFavourite(chosen, favourite);
  };
  starButton.connect('clicked', () => setFavourite(true));
  unstarButton.connect('clicked', () => setFavourite(false));
  unmuteButton.connect('clicked', () => setMute({ muted: false, until: null }));
  readButton.connect('clicked', () => setRead(true));
  unreadButton.connect('clicked', () => setRead(false));
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
      // The index has answered, so the placeholder rows have said all they can -- from here the
      // list shows what is there, including nothing.
      read = true;
      stack.update_state([Gtk.AccessibleState.BUSY], [false]);
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
    setLoading(on) {
      // A first read that ends without entries -- an unreadable or empty index -- still ends the
      // placeholder: it is replaced by the empty state, which says what happened.
      if (!on && !read) {
        read = true;
        stack.update_state([Gtk.AccessibleState.BUSY], [false]);
        rebuild();
      }
      busy.set_visible(on && read);
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
    pickFirst(count) {
      setPicking(true);
      for (const entry of entries.slice(0, count)) if (!picked.has(entry.id)) pick(entry);
    },
    chooseProtocol(backend) {
      if (!entries.some((e) => e.backend === backend)) return;
      backends.add(backend);
      rebuildFilters();
      rebuild();
    },
  };
}
