/** The appearance groups of the preferences dialog (ADR 0013): style toggles, primary and accent colour. */

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';

import {
  ACCENT_NAMES,
  type AccentName,
  accentToImpose,
  BACKGROUND_CHOICES,
  type BackgroundChoice,
  backgroundToShow,
  COLOR_SCHEMES,
  type ColorScheme,
  DESIGN_PACKS,
  isColorScheme,
  type Look,
  packOf,
  primaryToImpose,
  schemeToImpose,
} from '../core/lib/appearance.ts';
import { applyAccent, applyColorScheme, applyPrimary } from './appearance.ts';
import { applyChatBackground } from './chat-background.ts';

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

interface AppearanceSettings {
  colorScheme?: string;
  primaryColor?: string;
  accentColor?: string;
  chatBackground?: string;
}

export interface AppearanceStore {
  read(): AppearanceSettings;
  write(change: AppearanceSettings): void;
}

/** The names of the design packs, by id; a function so the strings are translated at run time. */
export function packLabels(): Record<string, string> {
  return {
    curlew: _('Curlew'),
    forest: _('Forest'),
    dusk: _('Dusk'),
    sunrise: _('Sunrise'),
    rose: _('Rose'),
    graphite: _('Graphite'),
  };
}

export function backgroundLabels(): Record<BackgroundChoice, string> {
  return { doodles: _('Doodles'), dots: _('Dots'), waves: _('Waves'), none: _('Plain') };
}

/** The groups: design pack, style, primary colour, accent colour, chat background. */
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
    system: _('System'),
    light: _('Light'),
    dark: _('Dark'),
  };
  const style = new Adw.PreferencesGroup({ title: _('Style') });
  // A segmented control, as in agent-access-page.ts: three fixed options, all visible at once.
  const scheme = new Adw.ToggleGroup({ homogeneous: true, halign: Gtk.Align.CENTER });
  for (const key of COLOR_SCHEMES) scheme.add(new Adw.Toggle({ name: key, label: schemeLabels[key] }));
  scheme.set_active_name(schemeToImpose(saved.colorScheme));
  scheme.connect('notify::active-name', () => {
    const key = scheme.get_active_name();
    if (!key || !isColorScheme(key)) return;
    store.write({ colorScheme: key });
    applyColorScheme(key);
  });
  const schemeBox = new Gtk.Box({ marginTop: 12, marginBottom: 12, marginStart: 12, marginEnd: 12 });
  schemeBox.set_halign(Gtk.Align.CENTER);
  schemeBox.append(scheme);
  style.add(row(schemeBox));

  // A colour group: a switch for "use my own", dots to pick it; off hands the choice to the system.
  const colourGroup = (
    title: string,
    switchTitle: string,
    subtitle: string,
    current: AccentName | null,
    fallback: AccentName,
    save: (value: string) => void,
    apply: (value: string) => void,
  ): { group: Adw.PreferencesGroup; set(name: AccentName): void } => {
    const group = new Adw.PreferencesGroup({ title, description: subtitle });
    const toggle = new Adw.SwitchRow({ title: switchTitle, active: current !== null });
    let chosen: AccentName = current ?? fallback;
    let quiet = false;
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
      if (quiet) return;
      const on = toggle.get_active();
      dots.setSensitive(on);
      dots.select(chosen);
      const value = on ? chosen : 'system';
      save(value);
      apply(value);
    });
    group.add(toggle);
    group.add(row(dots.box));
    return {
      group,
      // A design pack picks the colour for the person: show it without saving a second time.
      set(name) {
        quiet = true;
        chosen = name;
        toggle.set_active(true);
        dots.setSensitive(true);
        dots.select(name);
        quiet = false;
      },
    };
  };

  let primaryNow = primaryToImpose(saved.primaryColor);
  let accentNow = accentToImpose(saved.accentColor);
  let backgroundNow = backgroundToShow(saved.chatBackground);
  const lookNow = (): Look => ({
    ...(primaryNow ? { primary: primaryNow } : {}),
    ...(accentNow ? { accent: accentNow } : {}),
    background: backgroundNow,
  });
  let quiet = false;
  const packNames = packLabels();
  const designs = new Adw.ComboRow({
    title: _('Design'),
    subtitle: _('Colours and background chosen to go together'),
    model: Gtk.StringList.new([_('Custom'), ...DESIGN_PACKS.map((pack) => packNames[pack.id] ?? pack.id)]),
  });
  // The row names the pack the three settings add up to, or "Custom" when they match none.
  const syncPack = (): void => {
    const pack = packOf(lookNow());
    quiet = true;
    designs.set_selected(pack ? DESIGN_PACKS.indexOf(pack) + 1 : 0);
    quiet = false;
  };
  syncPack();
  const design = new Adw.PreferencesGroup();
  design.add(designs);

  const primary = colourGroup(
    _('Primary colour'),
    _('Use a custom primary colour'),
    _('Tints the window and its panels'),
    primaryToImpose(saved.primaryColor),
    'blue',
    (value) => {
      primaryNow = primaryToImpose(value);
      store.write({ primaryColor: value });
      syncPack();
    },
    applyPrimary,
  );
  const accent = colourGroup(
    _('Accent colour'),
    _('Use a custom accent colour'),
    _('Colours buttons, links and your own messages'),
    accentToImpose(saved.accentColor),
    'teal',
    (value) => {
      accentNow = accentToImpose(value);
      store.write({ accentColor: value });
      syncPack();
    },
    applyAccent,
  );

  const backgroundNames = backgroundLabels();
  const background = new Adw.ComboRow({
    title: _('Chat background'),
    subtitle: _('A quiet pattern behind the messages'),
    model: Gtk.StringList.new(BACKGROUND_CHOICES.map((choice) => backgroundNames[choice])),
    selected: Math.max(0, BACKGROUND_CHOICES.indexOf(backgroundNow)),
  });
  background.connect('notify::selected', () => {
    if (quiet) return;
    backgroundNow = BACKGROUND_CHOICES[background.get_selected()] ?? 'doodles';
    store.write({ chatBackground: backgroundNow });
    applyChatBackground(backgroundNow);
    syncPack();
  });
  const backgroundGroup = new Adw.PreferencesGroup();
  backgroundGroup.add(background);

  designs.connect('notify::selected', () => {
    const pack = DESIGN_PACKS[designs.get_selected() - 1];
    if (quiet || !pack) return;
    primaryNow = pack.primary;
    accentNow = pack.accent;
    backgroundNow = pack.background;
    store.write({ primaryColor: pack.primary, accentColor: pack.accent, chatBackground: pack.background });
    applyPrimary(pack.primary);
    applyAccent(pack.accent);
    applyChatBackground(pack.background);
    primary.set(pack.primary);
    accent.set(pack.accent);
    quiet = true;
    background.set_selected(BACKGROUND_CHOICES.indexOf(pack.background));
    quiet = false;
  });
  return [design, style, primary.group, accent.group, backgroundGroup];
}
