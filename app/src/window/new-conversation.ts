/**
 * The contact picker for a new conversation: a search field over the address book and one row
 * per contact that has an address a first message can go to. Adwaita's own widgets only.
 */

import Adw from 'gi://Adw?version=1';
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

  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE });
  list.add_css_class('navigation-sidebar');
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
  const fill = (query: string) => {
    generation += 1;
    const mine = generation;
    load(query).then(
      (found) => {
        if (mine !== generation) return;
        const shown = offeredContacts(found, accounts, query);
        let row = list.get_first_child();
        while (row) {
          const next = row.get_next_sibling();
          list.remove(row);
          row = next;
        }
        for (const contact of shown) {
          const item = new Adw.ActionRow({
            title: contact.name,
            subtitle: contactSubtitle(contact, accounts),
            activatable: true,
          });
          item.set_title_lines(1);
          item.set_subtitle_lines(1);
          item.add_prefix(new Adw.Avatar({ size: 40, text: contact.name, showInitials: true }));
          item.connect('activated', () => {
            dialog.close();
            onPick(contact);
          });
          list.append(item);
        }
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
  fill('');
  dialog.present(parent);
  search.grab_focus();
}
