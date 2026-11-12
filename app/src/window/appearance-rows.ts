/** The appearance groups of the preferences dialog (ADR 0013): style circles, primary and accent colour. */

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';

import {
  ACCENT_NAMES,
  type AccentName,
  accentToImpose,
  COLOR_SCHEMES,
  type ColorScheme,
  primaryToImpose,
  schemeToImpose,
} from '../core/lib/appearance.ts';
import { applyAccent, applyColorScheme, applyPrimary } from './appearance.ts';

// Round swatches, as in Learn6502's selectors: the circle is the widget's own background, and the
// checked one wears a ring in the accent colour. Colour only; the layout is plain GTK.
const SWATCH_CSS = `
.curlew-swatch {
  background-clip: content-box;
  border-radius: 9999px;
  padding: 6px;
  min-width: 24px;
  min-height: 24px;
  box-shadow: inset 0 0 0 3px transparent;
}
.curlew-swatch radio {
  -gtk-icon-source: none;
  border: none;
  background: none;
  box-shadow: none;
  min-width: 12px;
  min-height: 12px;
  padding: 0;
}
.curlew-swatch:checked { box-shadow: inset 0 0 0 3px @accent_bg_color; }
.curlew-swatch:disabled { opacity: 0.5; }
.curlew-swatch.style { min-width: 44px; min-height: 44px; }
.curlew-swatch.follow { background-image: linear-gradient(to bottom right, #fafafb 49.99%, #222226 50.01%); }
.curlew-swatch.light { background-color: #fafafb; }
.curlew-swatch.dark { background-color: #222226; }
${ACCENT_NAMES.map((name) => `.curlew-swatch.${name} { background-color: var(--accent-${name}); }`).join('\n')}
`;

let swatchesInstalled = false;

function installSwatches(): void {
  const display = Gdk.Display.get_default();
  if (swatchesInstalled || !display) return;
  swatchesInstalled = true;
  const provider = new Gtk.CssProvider();
  provider.load_from_string(SWATCH_CSS);
  Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

/** Radio swatches in one group; `choose` hears the key of the one the person picks. */
function swatches<K extends string>(
  keys: readonly K[],
  label: (key: K) => string,
  classes: (key: K) => string[],
  current: K,
  choose: (key: K) => void,
): { box: Gtk.Widget; select(key: K): void; setSensitive(on: boolean): void } {
  const box = new Adw.WrapBox({ childSpacing: 8, lineSpacing: 8, halign: Gtk.Align.CENTER });
  box.set_margin_top(12);
  box.set_margin_bottom(12);
  const buttons = new Map<K, Gtk.CheckButton>();
  let first: Gtk.CheckButton | null = null;
  let quiet = false;
  for (const key of keys) {
    const button = new Gtk.CheckButton({
      halign: Gtk.Align.CENTER,
      valign: Gtk.Align.CENTER,
      focusOnClick: false,
      tooltipText: label(key),
      cssClasses: ['curlew-swatch', ...classes(key)],
    });
    button.update_property([Gtk.AccessibleProperty.LABEL], [label(key)]);
    if (first) button.set_group(first);
    else first = button;
    button.connect('toggled', () => {
      if (!quiet && button.get_active()) choose(key);
    });
    buttons.set(key, button);
    box.append(button);
  }
  buttons.get(current)?.set_active(true);
  return {
    box,
    select(key) {
      quiet = true;
      buttons.get(key)?.set_active(true);
      quiet = false;
    },
    setSensitive(on) {
      box.set_sensitive(on);
    },
  };
}

const row = (child: Gtk.Widget): Gtk.ListBoxRow =>
  new Gtk.ListBoxRow({ activatable: false, selectable: false, child });

export interface AppearanceStore {
  read(): { colorScheme?: string; primaryColor?: string; accentColor?: string };
  write(change: { colorScheme?: string; primaryColor?: string; accentColor?: string }): void;
}

/** The three groups: style, primary colour, accent colour. */
export function appearanceGroups(store: AppearanceStore): Adw.PreferencesGroup[] {
  installSwatches();
  const saved = store.read();
  const colourLabels: Record<AccentName, string> = {
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

  const schemeLabels: Record<ColorScheme, string> = {
    system: _('Follow the system style'),
    light: _('Light style'),
    dark: _('Dark style'),
  };
  const style = new Adw.PreferencesGroup({ title: _('Style') });
  const scheme = swatches(
    COLOR_SCHEMES,
    (key) => schemeLabels[key],
    (key) => ['style', key === 'system' ? 'follow' : key],
    schemeToImpose(saved.colorScheme),
    (key) => {
      store.write({ colorScheme: key });
      applyColorScheme(key);
    },
  );
  style.add(row(scheme.box));

  // A colour group: a switch for "use my own", dots to pick it; off hands the choice to the system.
  const colourGroup = (
    title: string,
    switchTitle: string,
    subtitle: string,
    current: AccentName | null,
    fallback: AccentName,
    save: (value: string) => void,
    apply: (value: string) => void,
  ): Adw.PreferencesGroup => {
    const group = new Adw.PreferencesGroup({ title, description: subtitle });
    const toggle = new Adw.SwitchRow({ title: switchTitle, active: current !== null });
    let chosen: AccentName = current ?? fallback;
    const dots = swatches(
      ACCENT_NAMES,
      (key) => colourLabels[key],
      (key) => [key],
      chosen,
      (key) => {
        chosen = key;
        save(key);
        apply(key);
      },
    );
    dots.setSensitive(toggle.get_active());
    toggle.connect('notify::active', () => {
      const on = toggle.get_active();
      dots.setSensitive(on);
      dots.select(chosen);
      const value = on ? chosen : 'system';
      save(value);
      apply(value);
    });
    group.add(toggle);
    group.add(row(dots.box));
    return group;
  };

  const primary = colourGroup(
    _('Primary colour'),
    _('Use a custom primary colour'),
    _('Tints the window and its panels'),
    primaryToImpose(saved.primaryColor),
    'blue',
    (value) => store.write({ primaryColor: value }),
    applyPrimary,
  );
  const accent = colourGroup(
    _('Accent colour'),
    _('Use a custom accent colour'),
    _('Colours buttons, links and your own messages'),
    accentToImpose(saved.accentColor),
    'teal',
    (value) => store.write({ accentColor: value }),
    applyAccent,
  );
  return [style, primary, accent];
}
