/** The message field: grows with what is typed up to a few lines; Enter sends, Shift+Enter breaks the line. */

import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { _ } from '@curlew/protocol';

/** Lines after which the field scrolls instead of growing further. */
const MAX_LINES = 5;
const LINE_HEIGHT = 22;

export interface ComposerInput {
  widget: Gtk.Widget;
  /** The editing widget: what paste and drop handlers attach to. */
  view: Gtk.TextView;
  /** Opens the emoji chooser; an emoji lands at the cursor. Hidden while the field is read-only. */
  emoji: Gtk.MenuButton;
  getText(): string;
  setText(text: string): void;
  setPlaceholder(text: string): void;
  setSensitive(on: boolean): void;
  grabFocus(): void;
  /** Called for Enter (without Shift) and nothing else. */
  onSubmit(callback: () => void): void;
}

export function createComposerInput(placeholder: string): ComposerInput {
  const view = new Gtk.TextView({
    wrapMode: Gtk.WrapMode.WORD_CHAR,
    acceptsTab: false,
    topMargin: 6,
    bottomMargin: 6,
    leftMargin: 6,
    rightMargin: 6,
    hexpand: true,
  });
  view.add_css_class('curlew-input');
  const buffer = view.get_buffer();

  const scroller = new Gtk.ScrolledWindow({
    child: view,
    hscrollbarPolicy: Gtk.PolicyType.NEVER,
    propagateNaturalHeight: true,
    // Not AUTOMATIC: its scrollbar forces a minimum height of 58 px even for an empty field.
    vscrollbarPolicy: Gtk.PolicyType.EXTERNAL,
    maxContentHeight: MAX_LINES * LINE_HEIGHT + 12,
    hexpand: true,
  });

  // A text view has no placeholder of its own: a label above it that lets every click through.
  const hint = new Gtk.Label({
    label: placeholder,
    xalign: 0,
    halign: Gtk.Align.START,
    valign: Gtk.Align.CENTER,
    marginStart: 6,
    canTarget: false,
    ellipsize: Pango.EllipsizeMode.END,
  });
  hint.add_css_class('dim-label');
  const overlay = new Gtk.Overlay({ child: scroller, hexpand: true });
  overlay.add_overlay(hint);
  const sync = (): void => hint.set_visible(buffer.get_char_count() === 0);
  buffer.connect('changed', sync);

  let submit: () => void = () => {};
  const keys = new Gtk.EventControllerKey();
  keys.connect('key-pressed', (_c, keyval, _code, state) => {
    if (keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) return false;
    if (state & (Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.CONTROL_MASK)) return false;
    submit();
    return true;
  });
  view.add_controller(keys);

  // Emoji are plain text on every protocol, so the chooser is offered wherever the field is.
  const chooser = new Gtk.EmojiChooser();
  chooser.connect('emoji-picked', (_c, emoji: string) => buffer.insert_at_cursor(emoji, -1));
  chooser.connect('closed', () => view.grab_focus());
  const emoji = new Gtk.MenuButton({
    iconName: 'face-smile-symbolic',
    tooltipText: _('Insert emoji'),
    popover: chooser,
    valign: Gtk.Align.END,
  });
  emoji.add_css_class('flat');
  emoji.add_css_class('circular');
  emoji.update_property([Gtk.AccessibleProperty.LABEL], [_('Insert emoji')]);

  const text = (): string => buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
  return {
    widget: overlay,
    view,
    emoji,
    getText: text,
    setText(value) {
      buffer.set_text(value, -1);
    },
    setPlaceholder(value) {
      hint.set_label(value);
    },
    setSensitive(on) {
      view.set_sensitive(on);
      emoji.set_visible(on);
    },
    grabFocus() {
      view.grab_focus();
    },
    onSubmit(callback) {
      submit = callback;
    },
  };
}
