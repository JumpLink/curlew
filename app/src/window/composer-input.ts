/** The emoji button of the composer bar: the field itself is the shared `ChatEntry`. */

import Gtk from 'gi://Gtk?version=4.0';

import type { ChatEntry } from '@gjsify/adwaita-extended';

import { _ } from '@curlew/protocol';
import { configPath } from '@curlew/store';

import { loadConfig, saveConfig } from '../core/config.ts';
import { createEmojiPopover } from './emoji-picker.ts';

/** Opens the emoji chooser; an emoji lands at the cursor of the entry. */
export function createEmojiButton(entry: ChatEntry): Gtk.MenuButton {
  const buffer = entry.textView.get_buffer();
  // Emoji are plain text on every protocol, so the chooser is offered wherever the field is.
  const chooser = createEmojiPopover((emoji) => buffer.insert_at_cursor(emoji, -1), {
    read: () => {
      try {
        return loadConfig(configPath()).ui.recentEmoji ?? [];
      } catch {
        return [];
      }
    },
    write: (list) => {
      try {
        const config = loadConfig(configPath());
        config.ui.recentEmoji = list;
        saveConfig(config, configPath());
      } catch {
        // A recent list is a convenience: an unwritable config must not break the picker.
      }
    },
  });
  chooser.connect('closed', () => entry.grabFocus());
  const emoji = new Gtk.MenuButton({
    iconName: 'face-smile-symbolic',
    tooltipText: _('Insert emoji'),
    popover: chooser,
    valign: Gtk.Align.END,
  });
  emoji.add_css_class('flat');
  emoji.add_css_class('circular');
  emoji.update_property([Gtk.AccessibleProperty.LABEL], [_('Insert emoji')]);
  return emoji;
}
