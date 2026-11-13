/**
 * The emoji picker popover. `Gtk.EmojiChooser` builds about 1800 buttons the first time it opens
 * (1.2 s blocked); a `Gtk.GridView` builds only the cells on screen. Search, group jump and a
 * "Recent" row come on top; arrow keys, Enter and Escape work as in any grid popover.
 */

import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';

import {
  allEmoji,
  emojiLabel,
  filterEmoji,
  groupStarts,
  knownRecent,
  type EmojiEntry,
  withRecent,
} from './emoji-model.ts';

export interface EmojiRecent {
  read(): string[];
  write(list: string[]): void;
}

function groupNames(): Record<string, string> {
  return {
    recent: _('Recent'),
    'smileys-emotion': _('Smileys & Emotion'),
    'people-body': _('People & Body'),
    'animals-nature': _('Animals & Nature'),
    'food-drink': _('Food & Drink'),
    'travel-places': _('Travel & Places'),
    activities: _('Activities'),
    objects: _('Objects'),
    symbols: _('Symbols'),
    flags: _('Flags'),
  };
}

/** A popover that calls `onPick` with the chosen emoji; its widgets are built when it is first shown. */
export function createEmojiPopover(onPick: (emoji: string) => void, recent?: EmojiRecent): Gtk.Popover {
  const popover = new Gtk.Popover({ autohide: true });
  let built = false;

  popover.connect('show', () => {
    if (built) return;
    built = true;
    const german = (GLib.get_language_names()[0] ?? '').startsWith('de');
    const entries = allEmoji();
    const byEmoji = new Map<string, EmojiEntry>(entries.map((entry) => [entry.emoji, entry]));
    let recentNow = knownRecent(recent?.read());
    // The model is [recent…, every emoji…]; searching swaps it for the hits.
    const model = Gtk.StringList.new([...recentNow, ...entries.map((entry) => entry.emoji)]);
    let searching = false;

    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (_f, item: Gtk.ListItem) => {
      const label = new Gtk.Label({ widthRequest: 40, heightRequest: 40 });
      label.add_css_class('title-3');
      item.set_child(label);
    });
    factory.connect('bind', (_f, item: Gtk.ListItem) => {
      const label = item.get_child() as Gtk.Label;
      const emoji = (item.get_item() as Gtk.StringObject).get_string();
      label.set_label(emoji);
      const entry = byEmoji.get(emoji);
      label.update_property([Gtk.AccessibleProperty.LABEL], [entry ? emojiLabel(entry, german) : emoji]);
      label.set_tooltip_text(entry ? emojiLabel(entry, german) : emoji);
    });

    const grid = new Gtk.GridView({
      model: new Gtk.NoSelection({ model }),
      factory,
      singleClickActivate: true,
      minColumns: 7,
      maxColumns: 7,
    });
    grid.connect('activate', (_g, position: number) => {
      const emoji = model.get_string(position);
      if (!emoji) return;
      if (recent) {
        recentNow = withRecent(recentNow, emoji);
        recent.write(recentNow);
      }
      popover.popdown();
      onPick(emoji);
    });
    const scroller = new Gtk.ScrolledWindow({
      child: grid,
      hscrollbarPolicy: Gtk.PolicyType.NEVER,
      minContentHeight: 280,
      minContentWidth: 300,
    });
    const empty = new Gtk.Label({ label: _('No emoji found'), vexpand: true });
    empty.add_css_class('dim-label');
    const stack = new Gtk.Stack();
    stack.add_named(scroller, 'grid');
    stack.add_named(empty, 'empty');

    const search = new Gtk.SearchEntry({ placeholderText: _('Search emoji'), marginBottom: 6 });
    search.update_property([Gtk.AccessibleProperty.LABEL], [_('Search emoji')]);
    const recentButton = new Gtk.Button({ label: '🕘' });
    const showAll = (): void => {
      searching = false;
      model.splice(0, model.get_n_items(), [...recentNow, ...entries.map((entry) => entry.emoji)]);
      stack.set_visible_child_name('grid');
      recentButton.set_visible(recentNow.length > 0);
    };
    search.connect('search-changed', () => {
      const text = search.get_text();
      if (!text.trim()) {
        if (searching) showAll();
        return;
      }
      searching = true;
      const hits = filterEmoji(text);
      model.splice(
        0,
        model.get_n_items(),
        hits.map((entry) => entry.emoji),
      );
      stack.set_visible_child_name(hits.length > 0 ? 'grid' : 'empty');
    });
    search.connect('activate', () => grid.grab_focus());
    const keys = new Gtk.EventControllerKey();
    keys.connect('key-pressed', (_c, keyval) => {
      if (keyval !== 0xff54 /* Down */) return false;
      grid.grab_focus();
      return true;
    });
    search.add_controller(keys);

    // Jump buttons: one per group, plus "Recent" while there is one. They scroll, they do not filter.
    const bar = new Gtk.Box({ spacing: 2, halign: Gtk.Align.CENTER, marginTop: 6 });
    const names = groupNames();
    const jump = (index: number): void => {
      search.set_text('');
      if (searching) showAll();
      grid.scroll_to(index, Gtk.ListScrollFlags.NONE, null);
    };
    const addJump = (button: Gtk.Button, id: string, start: () => number): void => {
      button.set_tooltip_text(names[id] ?? id);
      button.add_css_class('flat');
      button.update_property([Gtk.AccessibleProperty.LABEL], [names[id] ?? id]);
      button.connect('clicked', () => jump(start()));
      bar.append(button);
    };
    addJump(recentButton, 'recent', () => 0);
    recentButton.set_visible(recentNow.length > 0);
    for (const target of groupStarts(0)) {
      addJump(new Gtk.Button({ label: target.icon }), target.id, () => {
        return groupStarts(recentNow.length).find((one) => one.id === target.id)?.start ?? 0;
      });
    }

    const box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      marginTop: 6,
      marginBottom: 6,
      marginStart: 6,
      marginEnd: 6,
    });
    box.append(search);
    box.append(stack);
    box.append(bar);
    popover.set_child(box);
    popover.connect('closed', () => {
      search.set_text('');
      showAll();
    });
    search.grab_focus();
  });
  return popover;
}
