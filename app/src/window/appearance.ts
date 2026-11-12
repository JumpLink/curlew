/** Imposes the chosen accent colour on the whole app (ADR 0013). */

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
  type AccentName,
  ACCENT_NAMES,
  accentToImpose,
  type ColorScheme,
  lookCss,
  primaryCss,
  primaryToImpose,
  schemeToImpose,
} from '../core/lib/appearance.ts';

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

// A `card` is translucent in dark mode, so the chat background shows through it. These two classes
// lay the same tint over the window colour instead, and give the person's own messages the accent.
const SURFACE_CSS = `
.curlew-surface {
  /* Twice: opaque in light, so no change there, and in dark it stacks the card's 8% white to ~15%. */
  background-image: linear-gradient(@card_bg_color, @card_bg_color), linear-gradient(@card_bg_color, @card_bg_color);
  background-color: @window_bg_color;
}
.curlew-input, .curlew-input text {
  background: none;
  color: inherit;
}
.curlew-own {
  background-image: none;
  background-color: @accent_bg_color;
  color: @accent_fg_color;
}
.curlew-own link { color: @accent_fg_color; }
`;

/** Install the opaque message surfaces once; they follow the accent through its named colours. */
export function installSurfaces(): void {
  const display = Gdk.Display.get_default();
  if (!display) return;
  const surfaces = new Gtk.CssProvider();
  surfaces.load_from_string(SURFACE_CSS);
  Gtk.StyleContext.add_provider_for_display(display, surfaces, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  installLooks(display);
}

// The rules a chat's own look switches on with a class; written for every colour once, and again
// when the style flips between light and dark because the tint is mixed from the scheme's surfaces.
function installLooks(display: Gdk.Display): void {
  const looks = new Gtk.CssProvider();
  const load = (): void => {
    const colors = Object.fromEntries(
      ACCENT_NAMES.map((name) => {
        const c = Adw.accent_color_to_rgba(ACCENTS[name]);
        return [name, [c.red * 255, c.green * 255, c.blue * 255] as const];
      }),
    ) as Record<AccentName, readonly [number, number, number]>;
    looks.load_from_string(lookCss(colors, Adw.StyleManager.get_default().get_dark()));
  };
  load();
  Adw.StyleManager.get_default().connect('notify::dark', load);
  Gtk.StyleContext.add_provider_for_display(display, looks, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

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

let primaryProvider: Gtk.CssProvider | null = null;
let primaryChoice: string | undefined;
let followingPrimary = false;

// The primary colour is a quiet tint over the window, header, sidebar, popover and dialog surfaces,
// built from libadwaita's own base colours so light and dark both keep their contrast.
function applyPrimaryTint(): void {
  const display = Gdk.Display.get_default();
  if (!display) return;
  if (primaryProvider) Gtk.StyleContext.remove_provider_for_display(display, primaryProvider);
  primaryProvider = null;
  const name = primaryToImpose(primaryChoice);
  if (name === null) return;
  const color = Adw.accent_color_to_rgba(ACCENTS[name]);
  const rgb = [color.red * 255, color.green * 255, color.blue * 255] as const;
  primaryProvider = new Gtk.CssProvider();
  primaryProvider.load_from_string(primaryCss(rgb, Adw.StyleManager.get_default().get_dark()));
  Gtk.StyleContext.add_provider_for_display(
    display,
    primaryProvider,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
  );
}

/** Apply `value` (the `ui.primaryColor` setting); the tint follows light and dark. */
export function applyPrimary(value: string | undefined): void {
  primaryChoice = value;
  if (!followingPrimary) {
    followingPrimary = true;
    Adw.StyleManager.get_default().connect('notify::dark', applyPrimaryTint);
  }
  applyPrimaryTint();
}

const SCHEMES: Record<ColorScheme, Adw.ColorScheme> = {
  system: Adw.ColorScheme.DEFAULT,
  light: Adw.ColorScheme.FORCE_LIGHT,
  dark: Adw.ColorScheme.FORCE_DARK,
};

/** Apply `value` (the `ui.colorScheme` setting): follow the desktop or force light or dark. */
export function applyColorScheme(value: string | undefined): void {
  Adw.StyleManager.get_default().set_color_scheme(SCHEMES[schemeToImpose(value)]);
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
