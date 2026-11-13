/**
 * The contact picker for a new conversation: a search field over the address book and one row
 * per contact that has an address a first message can go to. Adwaita's own widgets only.
 */

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import type { ContactDTO } from '@curlew/protocol';
import { _ } from '@curlew/protocol';

import {
  type RouteAccount,
  contactSubtitle,
  emptyMessage,
  offeredContacts,
} from './new-conversation-model.ts';

export function presentNewConversation(
  parent: Gtk.Widget | null,
  accounts: readonly RouteAccount[],
  load: (query: string) => Promise<ContactDTO[]>,
  onPick: (contact: ContactDTO) => void,
): void {
  const dialog = new Adw.Dialog({ title: _('New conversation'), contentWidth: 360, contentHeight: 520 });
  const view = new Adw.ToolbarView();
  view.add_top_bar(new Adw.HeaderBar());
  dialog.set_child(view);

  const search = new Gtk.SearchEntry({ placeholderText: _('Search contacts'), hexpand: true });
  const searchBox = new Gtk.Box({ marginStart: 12, marginEnd: 12, marginBottom: 6 });
  searchBox.append(search);
  view.add_top_bar(searchBox);

  // A ListView builds rows only for what is on screen, so a long address book costs the same as a short one.
  let shown: ContactDTO[] = [];
  const model = new Gtk.StringList();
  const avatars = new WeakMap<Adw.ActionRow, Adw.Avatar>();
  const factory = new Gtk.SignalListItemFactory();
  factory.connect('setup', (_f, item) => {
    const row = new Adw.ActionRow({ activatable: false });
    row.set_title_lines(1);
    row.set_subtitle_lines(1);
    const avatar = new Adw.Avatar({ size: 40, showInitials: true });
    avatars.set(row, avatar);
    row.add_prefix(avatar);
    (item as Gtk.ListItem).set_child(row);
  });
  factory.connect('bind', (_f, item) => {
    const listItem = item as Gtk.ListItem;
    const contact = shown[listItem.get_position()];
    const row = listItem.get_child() as Adw.ActionRow;
    if (!contact) return;
    row.set_title(GLib.markup_escape_text(contact.name, -1));
    row.set_subtitle(GLib.markup_escape_text(contactSubtitle(contact, accounts), -1));
    avatars.get(row)?.set_text(contact.name);
  });
  const list = new Gtk.ListView({
    model: new Gtk.NoSelection({ model }),
    factory,
    singleClickActivate: true,
  });
  list.add_css_class('navigation-sidebar');
  list.connect('activate', (_l, position) => {
    const contact = shown[position];
    if (!contact) return;
    dialog.close();
    onPick(contact);
  });
  const scroller = new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true });
  scroller.set_child(list);
  const empty = new Adw.StatusPage({ iconName: 'avatar-default-symbolic', vexpand: true });
  empty.add_css_class('compact');
  const stack = new Gtk.Stack();
  stack.add_named(scroller, 'list');
  stack.add_named(empty, 'empty');
  view.set_content(stack);

  // A slower answer to an older query must not replace the newer one.
  let generation = 0;
  dialog.connect('closed', () => {
    generation += 1;
  });
  const fill = (query: string) => {
    generation += 1;
    const mine = generation;
    load(query).then(
      (found) => {
        if (mine !== generation) return;
        shown = offeredContacts(found, accounts, query);
        model.splice(
          0,
          model.get_n_items(),
          shown.map((_c, i) => String(i)),
        );
        empty.set_title(emptyMessage(query.trim() !== ''));
        stack.set_visible_child_name(shown.length > 0 ? 'list' : 'empty');
      },
      (err: unknown) => {
        if (mine !== generation) return;
        empty.set_title(_('The address book could not be read'));
        empty.set_description(err instanceof Error ? err.message : String(err));
        stack.set_visible_child_name('empty');
      },
    );
  };
  search.connect('search-changed', () => fill(search.get_text()));
  dialog.present(parent);
  search.grab_focus();
  GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => (fill(''), GLib.SOURCE_REMOVE));
}
