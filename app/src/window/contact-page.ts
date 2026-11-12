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
import { deleteOwnPicture, saveOwnPicture, showPicture } from './contact-picture.ts';
import {
  type ListEntry,
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

/** A direct chat with someone known has a page; groups, the note to self and drafts have none. */
export function hasContactPage(entry: ListEntry): boolean {
  return entry.kind === 'direct' && entry.self !== true && entry.personIds.length > 0;
}

const parts = (entry: ListEntry): ListEntry[] => (entry.members.length > 0 ? entry.members : [entry]);

/** The name a merged row has when the person chose none: the newest part's, as in the list. */
function automaticTitle(entry: ListEntry): string {
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

export function presentContactPage(
  parent: Gtk.Widget | null,
  entry: ListEntry,
  initial: ContactChoice,
  labels: ReadonlyMap<string, string>,
  tools: ContactPageTools,
): void {
  const ids = [...entry.personIds];
  const members = parts(entry);
  const merged = entry.members.length > 1;
  const choice: ContactChoice = { ...initial };
  const fallback = automaticTitle(entry);

  const dialog = new Adw.Dialog({ title: _('Contact'), contentWidth: 400, contentHeight: 600 });
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
    for (const field of ['name', 'picture', 'own'] as const) {
      const value = patch[field];
      if (value === null) delete choice[field];
      else if (value !== undefined) choice[field] = value;
    }
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
