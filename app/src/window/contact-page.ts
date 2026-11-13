/**
 * The contact page: one person, however many chats they come in on. It shows which chats a merged
 * contact is made of, lets the person pick whose name and picture to use, or a picture of their
 * own. Presentation only, kept in the config; the address book is never written. Adwaita's own
 * widgets only.
 */

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _, _n, fmt } from '@curlew/protocol';

import type { ContactChoice } from '../core/config.ts';
import type { ChoicePatch } from '../core/contact-choices.ts';
import {
  ACCENT_NAMES,
  type AccentName,
  BACKGROUND_CHOICES,
  DESIGN_PACKS,
  lookOfPack,
  packOf,
} from '../core/lib/appearance.ts';
import { backgroundLabels, packLabels } from './appearance-rows.ts';
import { deleteOwnPicture, saveOwnPicture, showPicture } from './contact-picture.ts';
import {
  type ListEntry,
  choiceIdsOf,
  entryProtocolSubtitle,
  listSubtitle,
  looksOf,
  protocolLabel,
} from './conversation-list-model.ts';

export interface ContactPageTools {
  /** Store a change of how this contact looks. */
  choose(ids: string[], patch: ChoicePatch): void;
  /** Undo a merge the person made by hand. */
  separate(ids: string[]): void;
  /** The page is gone: refresh the list and the open header once. */
  closed(): void;
}

const HERO_SIZE = 96;
const ROW_AVATAR_SIZE = 32;

/** A direct chat with someone known and a group have a page; the note to self and drafts have none. */
export function hasContactPage(entry: ListEntry): boolean {
  if (entry.self === true) return false;
  return entry.kind === 'group' || (entry.kind === 'direct' && entry.personIds.length > 0);
}

const isGroup = (entry: ListEntry): boolean => entry.kind === 'group';

const parts = (entry: ListEntry): ListEntry[] => (entry.members.length > 0 ? entry.members : [entry]);

/** The name a merged row has when the person chose none: the newest part's, as in the list. */
function automaticTitle(entry: ListEntry): string {
  if (entry.automaticTitle !== undefined) return entry.automaticTitle;
  const newest = parts(entry).reduce((a, b) => ((a.lastMessageAt ?? '') >= (b.lastMessageAt ?? '') ? a : b));
  return entry.members.length > 0 ? newest.title : entry.title;
}

function radioRow(
  title: string,
  subtitle: string,
  group: Gtk.CheckButton | null,
  active: boolean,
  prefix: Gtk.Widget | null,
  onPick: () => void,
): { row: Adw.ActionRow; check: Gtk.CheckButton } {
  const row = new Adw.ActionRow({ title, subtitle, activatable: true });
  row.set_title_lines(1);
  row.set_subtitle_lines(1);
  const check = new Gtk.CheckButton({ valign: Gtk.Align.CENTER, active });
  if (group) check.set_group(group);
  check.connect('toggled', () => {
    if (check.get_active()) onPick();
  });
  if (prefix) row.add_prefix(prefix);
  row.add_suffix(check);
  row.set_activatable_widget(check);
  return { row, check };
}

function partAvatar(part: ListEntry): Adw.Avatar {
  const avatar = new Adw.Avatar({ size: ROW_AVATAR_SIZE, text: part.title, showInitials: true });
  showPicture(avatar, part);
  return avatar;
}

/**
 * The chat's own look: a design pack sets colours and pattern together, the two rows below it
 * change one part. Every row starts with "Like the rest of the app", which clears its part.
 */
function lookGroup(choice: ContactChoice, apply: (patch: ChoicePatch) => void): Adw.PreferencesGroup {
  const same = _('Like the rest of the app');
  const colours: Record<AccentName, string> = {
    blue: _('Blue'),
    teal: _('Teal'),
    green: _('Green'),
    yellow: _('Yellow'),
    orange: _('Orange'),
    red: _('Red'),
    pink: _('Pink'),
    purple: _('Purple'),
    slate: _('Slate'),
  };
  const packNames = packLabels();
  const patterns = backgroundLabels();
  const group = new Adw.PreferencesGroup({
    title: _('Look'),
    description: _('Give this chat its own colours and background'),
  });
  const designs = new Adw.ComboRow({
    title: _('Design'),
    model: Gtk.StringList.new([same, ...DESIGN_PACKS.map((pack) => packNames[pack.id] ?? pack.id)]),
  });
  const accents = new Adw.ComboRow({
    title: _('Accent colour'),
    model: Gtk.StringList.new([same, ...ACCENT_NAMES.map((name) => colours[name])]),
  });
  const backgrounds = new Adw.ComboRow({
    title: _('Chat background'),
    model: Gtk.StringList.new([same, ...BACKGROUND_CHOICES.map((name) => patterns[name])]),
  });
  let quiet = false;
  // A pack is shown only while the chat's three parts are exactly that pack's; a mix of parts is
  // none, so the row stays empty instead of naming a pack the chat does not wear.
  const sync = (): void => {
    quiet = true;
    const pack = packOf(choice);
    const own =
      choice.primary !== undefined || choice.accent !== undefined || choice.background !== undefined;
    designs.set_selected(pack ? DESIGN_PACKS.indexOf(pack) + 1 : own ? Gtk.INVALID_LIST_POSITION : 0);
    accents.set_selected(choice.accent ? ACCENT_NAMES.indexOf(choice.accent) + 1 : 0);
    backgrounds.set_selected(choice.background ? BACKGROUND_CHOICES.indexOf(choice.background) + 1 : 0);
    quiet = false;
  };
  sync();
  designs.connect('notify::selected', () => {
    if (quiet) return;
    const at = designs.get_selected();
    if (at === Gtk.INVALID_LIST_POSITION) return;
    const pack = DESIGN_PACKS[at - 1];
    apply(pack ? lookOfPack(pack) : { primary: null, accent: null, background: null });
    sync();
  });
  accents.connect('notify::selected', () => {
    if (quiet) return;
    apply({ accent: ACCENT_NAMES[accents.get_selected() - 1] ?? null });
    sync();
  });
  backgrounds.connect('notify::selected', () => {
    if (quiet) return;
    apply({ background: BACKGROUND_CHOICES[backgrounds.get_selected() - 1] ?? null });
    sync();
  });
  group.add(designs);
  group.add(accents);
  group.add(backgrounds);
  return group;
}

export function presentContactPage(
  parent: Gtk.Widget | null,
  entry: ListEntry,
  initial: ContactChoice,
  labels: ReadonlyMap<string, string>,
  tools: ContactPageTools,
): void {
  const ids = choiceIdsOf(entry);
  const group = isGroup(entry);
  const members = parts(entry);
  const merged = entry.members.length > 1;
  const choice: ContactChoice = { ...initial };
  const fallback = automaticTitle(entry);

  const dialog = new Adw.Dialog({
    title: group ? _('Group') : _('Contact'),
    contentWidth: 400,
    contentHeight: 600,
  });
  const toasts = new Adw.ToastOverlay();
  const view = new Adw.ToolbarView();
  view.add_top_bar(new Adw.HeaderBar());
  toasts.set_child(view);
  dialog.set_child(toasts);

  // The row as the list shows it with the current choice, for the big picture and the name.
  const shown = (): ListEntry => {
    const base: ListEntry = { ...entry, title: fallback };
    delete base.picture;
    return { ...base, ...looksOf(choice, members) };
  };

  const avatar = new Adw.Avatar({ size: HERO_SIZE, showInitials: true, halign: Gtk.Align.CENTER });
  const name = new Gtk.Label({ wrap: true, justify: Gtk.Justification.CENTER });
  name.add_css_class('title-1');
  const subtitle = new Gtk.Label({
    label: merged
      ? fmt(_n('Combined from {count} chat', 'Combined from {count} chats', members.length), {
          count: members.length,
        })
      : group
        ? groupSubtitle(entry)
        : entryProtocolSubtitle(entry),
    wrap: true,
    justify: Gtk.Justification.CENTER,
  });
  subtitle.add_css_class('dim-label');
  const change = new Gtk.Button({ label: _('Choose Picture…') });
  change.add_css_class('pill');
  const remove = new Gtk.Button({ label: _('Remove Picture') });
  remove.add_css_class('pill');
  const pictureButtons = new Gtk.Box({ spacing: 12, halign: Gtk.Align.CENTER });
  pictureButtons.append(change);
  pictureButtons.append(remove);

  const column = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 18,
    marginTop: 12,
    marginBottom: 24,
    marginStart: 12,
    marginEnd: 12,
  });
  const hero = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
  hero.append(avatar);
  hero.append(name);
  hero.append(subtitle);
  column.append(hero);
  column.append(pictureButtons);

  let ownNote: PictureHint | null = null;
  const refresh = () => {
    const now = shown();
    name.set_label(now.title);
    avatar.set_text(now.title);
    avatar.set_custom_image(null);
    showPicture(avatar, now);
    remove.set_visible(choice.own !== undefined);
    ownNote?.sync();
  };

  const apply = (patch: ChoicePatch) => {
    const set = <K extends keyof ContactChoice>(field: K, value: ContactChoice[K] | null | undefined) => {
      if (value === null) delete choice[field];
      else if (value !== undefined) choice[field] = value;
    };
    for (const field of ['title', 'name', 'picture', 'own'] as const) set(field, patch[field]);
    for (const field of ['primary', 'accent', 'background'] as const) set(field, patch[field]);
    tools.choose(ids, patch);
    refresh();
  };

  if (merged) {
    // The name is one pick of a few short strings: a combo row, so the page stays short.
    const nameGroup = new Adw.PreferencesGroup();
    const names = new Adw.ComboRow({
      title: _('Name'),
      subtitle: _('The newest chat decides'),
      model: Gtk.StringList.new([
        _('Automatic'),
        ...members.map((part) => `${part.title} · ${protocolLabel(part.backend)}`),
      ]),
      selected: Math.max(0, members.findIndex((part) => part.id === choice.name) + 1),
    });
    names.connect('notify::selected', () => {
      const part = members[names.get_selected() - 1];
      apply({ name: part ? part.id : null });
    });
    nameGroup.add(names);
    column.append(nameGroup);

    const pictureGroup = new Adw.PreferencesGroup({ title: _('Picture') });
    ownNote = hint(pictureGroup, () => choice.own !== undefined);
    const first = radioRow(
      _('Automatic'),
      _('The newest chat decides'),
      null,
      choice.picture === undefined,
      null,
      () => apply({ picture: null }),
    );
    pictureGroup.add(first.row);
    for (const part of members) {
      const line = `${protocolLabel(part.backend)} · ${listSubtitle(part, labels)}`;
      const row = radioRow(part.title, line, first.check, choice.picture === part.id, partAvatar(part), () =>
        apply({ picture: part.id }),
      );
      pictureGroup.add(row.row);
    }
    column.append(pictureGroup);
  }

  if (group) {
    const nameGroup = new Adw.PreferencesGroup();
    const nameRow = new Adw.EntryRow({ title: _('Name'), text: choice.title ?? fallback });
    nameRow.set_show_apply_button(true);
    nameRow.connect('apply', () => {
      const typed = nameRow.get_text().trim();
      apply({ title: typed === '' || typed === fallback ? null : typed });
    });
    nameGroup.add(nameRow);
    column.append(nameGroup);
    column.append(infoGroup(entry, labels));
  }

  column.append(lookGroup(choice, apply));

  if (merged && entry.manual) {
    const group = new Adw.PreferencesGroup();
    const row = new Adw.ActionRow({
      title: _('Separate'),
      subtitle: _('Show these chats as separate people again'),
      activatable: true,
    });
    row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic' }));
    row.connect('activated', () => {
      tools.separate(ids);
      dialog.close();
    });
    group.add(row);
    column.append(group);
  }

  change.connect('clicked', () => {
    const filter = new Gtk.FileFilter();
    filter.set_name(_('Images'));
    filter.add_mime_type('image/*');
    const filters = new Gio.ListStore({ itemType: Gtk.FileFilter });
    filters.append(filter);
    const chooser = new Gtk.FileDialog({ title: _('Choose a Picture'), filters, defaultFilter: filter });
    chooser.open((dialog.get_root() as Gtk.Window | null) ?? null, null, (_source, result) => {
      let path: string | null;
      try {
        path = chooser.open_finish(result)?.get_path() ?? null;
      } catch {
        return; // dismissed
      }
      if (path === null) return;
      let file: string;
      try {
        file = saveOwnPicture(path);
      } catch {
        toasts.add_toast(new Adw.Toast({ title: _('This file is not a picture'), timeout: 4 }));
        return;
      }
      const previous = choice.own;
      apply({ own: file });
      if (previous !== undefined) deleteOwnPicture(previous);
    });
  });
  remove.connect('clicked', () => {
    const previous = choice.own;
    apply({ own: null });
    if (previous !== undefined) deleteOwnPicture(previous);
  });

  const scroller = new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true });
  const clamp = new Adw.Clamp({ maximumSize: 480, tighteningThreshold: 360 });
  clamp.set_child(column);
  scroller.set_child(clamp);
  view.set_content(scroller);

  refresh();
  dialog.connect('closed', () => tools.closed());
  dialog.present(parent);
}

const countOf = (entry: ListEntry): number | null =>
  entry.room?.memberCount ??
  (entry.groupMembers && entry.groupMembers.length > 0 ? entry.groupMembers.length : null);

function groupSubtitle(entry: ListEntry): string {
  const count = countOf(entry);
  const protocol = entryProtocolSubtitle(entry);
  return count === null
    ? protocol
    : `${protocol} · ${fmt(_n('{count} member', '{count} members', count), { count })}`;
}

/** What the index knows about the group: network, account, room facts and the members it has. */
function infoGroup(entry: ListEntry, labels: ReadonlyMap<string, string>): Adw.PreferencesGroup {
  const group = new Adw.PreferencesGroup({ title: _('About') });
  const line = (title: string, value: string): void => {
    const row = new Adw.ActionRow({ title, subtitle: value, subtitleSelectable: true });
    row.add_css_class('property');
    group.add(row);
  };
  line(_('Protocol'), protocolLabel(entry.backend));
  line(_('Account'), labels.get(entry.accountId) ?? protocolLabel(entry.backend));
  const count = countOf(entry);
  if (count !== null) line(_('Members'), String(count));
  const room = entry.room;
  if (room?.public != null) line(_('Visibility'), room.public ? _('Public room') : _('Private room'));
  if (room?.encrypted != null) line(_('Encryption'), room.encrypted ? _('Encrypted') : _('Not encrypted'));
  const people = entry.groupMembers ?? [];
  if (people.length > 0) {
    const expander = new Adw.ExpanderRow({
      title: _('Members the app knows'),
      subtitle: fmt(_n('{count} person', '{count} people', people.length), { count: people.length }),
    });
    for (const person of people) {
      const row = new Adw.ActionRow({ title: person });
      row.set_title_lines(1);
      const avatar = new Adw.Avatar({ size: ROW_AVATAR_SIZE, text: person, showInitials: true });
      row.add_prefix(avatar);
      expander.add_row(row);
    }
    group.add(expander);
  }
  return group;
}

interface PictureHint {
  sync(): void;
}

/** One line under the Picture group's title while an own picture overrides the chosen part. */
function hint(group: Adw.PreferencesGroup, hasOwn: () => boolean): PictureHint {
  const text = _('Your own picture is shown instead');
  return {
    sync: () => group.set_description(hasOwn() ? text : ''),
  };
}
