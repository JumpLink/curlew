/** Imposes the chosen accent colour on the whole app (ADR 0013). */

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

import { type AccentName, accentToImpose } from '../core/lib/appearance.ts';

const ACCENTS: Record<AccentName, Adw.AccentColor> = {
  blue: Adw.AccentColor.BLUE,
  teal: Adw.AccentColor.TEAL,
  green: Adw.AccentColor.GREEN,
  yellow: Adw.AccentColor.YELLOW,
  orange: Adw.AccentColor.ORANGE,
  red: Adw.AccentColor.RED,
  pink: Adw.AccentColor.PINK,
  purple: Adw.AccentColor.PURPLE,
  slate: Adw.AccentColor.SLATE,
};

let provider: Gtk.CssProvider | null = null;
let choice: string | undefined;
let following = false;

// libadwaita builds every accent-coloured widget from these three named colours, so overriding
// them recolours buttons, switches, links and focus rings together instead of one widget at a time.
function apply(): void {
  const display = Gdk.Display.get_default();
  if (!display) return;
  const name = accentToImpose(choice);
  if (provider) Gtk.StyleContext.remove_provider_for_display(display, provider);
  provider = null;
  if (name === null) return;
  const accent = ACCENTS[name];
  const dark = Adw.StyleManager.get_default().get_dark();
  provider = new Gtk.CssProvider();
  provider.load_from_string(
    `@define-color accent_bg_color ${Adw.accent_color_to_rgba(accent).to_string()};
@define-color accent_color ${Adw.accent_color_to_standalone_rgba(accent, dark).to_string()};
@define-color accent_fg_color white;`,
  );
  Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

/** Apply `value` (the `ui.accentColor` setting); the standalone shade follows light and dark. */
export function applyAccent(value: string | undefined): void {
  choice = value;
  if (!following) {
    following = true;
    Adw.StyleManager.get_default().connect('notify::dark', apply);
  }
  apply();
}
