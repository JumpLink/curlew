/** The accent choices of the window (ADR 0013); GTK-free so the config can validate them. */

/** The Adwaita accent names, in the order libadwaita lists them. */
export const ACCENT_NAMES = ['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'slate'] as const;
export type AccentName = (typeof ACCENT_NAMES)[number];

/** `default` is Curlew's own teal (distinct from the desktop's usual blue), `system` leaves the desktop's accent alone. */
export const ACCENT_CHOICES = ['default', 'system', ...ACCENT_NAMES] as const;
export type AccentChoice = (typeof ACCENT_CHOICES)[number];

export function isAccentChoice(value: string): value is AccentChoice {
  return (ACCENT_CHOICES as readonly string[]).includes(value);
}

/** The accent to impose, or null when the desktop's own stays. An unset or unknown value is `default`. */
export function accentToImpose(choice: string | undefined): AccentName | null {
  if (choice === 'system') return null;
  return (ACCENT_NAMES as readonly string[]).includes(choice ?? '') ? (choice as AccentName) : 'teal';
}

/** The primary colour tints the window surfaces; unset is blue, `system` is no tint. */
export function primaryToImpose(choice: string | undefined): AccentName | null {
  if (choice === 'system') return null;
  return (ACCENT_NAMES as readonly string[]).includes(choice ?? '') ? (choice as AccentName) : 'blue';
}

/** The style of the app: follow the desktop, or force light or dark. */
export const COLOR_SCHEMES = ['system', 'light', 'dark'] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

export function isColorScheme(value: string): value is ColorScheme {
  return (COLOR_SCHEMES as readonly string[]).includes(value);
}

/** An unset or unknown value follows the system. */
export function schemeToImpose(choice: string | undefined): ColorScheme {
  return choice !== undefined && isColorScheme(choice) ? choice : 'system';
}

export type Rgb = readonly [number, number, number];

/** libadwaita's own surface colours (1.8), the base a primary colour is mixed into. */
const SURFACES = {
  light: {
    window_bg_color: '#fafafb',
    view_bg_color: '#ffffff',
    headerbar_bg_color: '#ffffff',
    sidebar_bg_color: '#ebebed',
    sidebar_backdrop_color: '#f2f2f4',
    dialog_bg_color: '#fafafb',
    popover_bg_color: '#ffffff',
  },
  dark: {
    window_bg_color: '#222226',
    view_bg_color: '#1d1d20',
    headerbar_bg_color: '#2e2e32',
    sidebar_bg_color: '#2e2e32',
    sidebar_backdrop_color: '#28282c',
    dialog_bg_color: '#36363a',
    popover_bg_color: '#36363a',
  },
} as const;

/** How much of the primary colour each scheme takes: quiet enough to keep text contrast. */
const TINT = { light: 0.2, dark: 0.26 } as const;

const channel = (hex: string, at: number): number => Number.parseInt(hex.slice(1 + at * 2, 3 + at * 2), 16);

/** `base` (`#rrggbb`) moved `amount` of the way towards `tint`, as `#rrggbb`. */
export function mixHex(base: string, tint: Rgb, amount: number): string {
  const part = (i: number): string =>
    Math.round(channel(base, i) * (1 - amount) + tint[i]! * amount)
      .toString(16)
      .padStart(2, '0');
  return `#${part(0)}${part(1)}${part(2)}`;
}

/** The `@define-color` lines that tint every window surface with `color` (0–255 per channel). */
export function primaryCss(color: Rgb, dark: boolean): string {
  const scheme = dark ? 'dark' : 'light';
  return Object.entries(SURFACES[scheme])
    .map(([name, base]) => `@define-color ${name} ${mixHex(base, color, TINT[scheme])};`)
    .join('\n');
}

/** What lies behind the messages of a conversation: one of our own quiet patterns, or nothing. */
export const BACKGROUND_CHOICES = ['doodles', 'dots', 'waves', 'none'] as const;
export type BackgroundChoice = (typeof BACKGROUND_CHOICES)[number];

export function isBackgroundChoice(value: string): value is BackgroundChoice {
  return (BACKGROUND_CHOICES as readonly string[]).includes(value);
}

/** An unset or unknown value is the default, the doodles. */
export function backgroundToShow(choice: string | undefined): BackgroundChoice {
  return choice !== undefined && isBackgroundChoice(choice) ? choice : 'doodles';
}

/** A colour that can be chosen for one chat: an Adwaita accent name, never `default` or `system`. */
export function isAccentName(value: string): value is AccentName {
  return (ACCENT_NAMES as readonly string[]).includes(value);
}

/**
 * How one chat differs from the rest of the app: a primary tint, an accent and a background, each
 * optional. An absent part follows the app-wide setting.
 */
export interface Look {
  primary?: AccentName;
  accent?: AccentName;
  background?: BackgroundChoice;
}

/** A ready-made look the person can pick for the whole app or for one chat. */
export interface DesignPack {
  id: string;
  primary: AccentName;
  accent: AccentName;
  background: BackgroundChoice;
}

/** The first pack is what an untouched install looks like. */
export const DESIGN_PACKS: readonly DesignPack[] = [
  { id: 'curlew', primary: 'blue', accent: 'teal', background: 'doodles' },
  { id: 'forest', primary: 'green', accent: 'green', background: 'dots' },
  { id: 'dusk', primary: 'purple', accent: 'purple', background: 'waves' },
  { id: 'sunrise', primary: 'orange', accent: 'orange', background: 'doodles' },
  { id: 'rose', primary: 'pink', accent: 'pink', background: 'dots' },
  { id: 'graphite', primary: 'slate', accent: 'slate', background: 'none' },
];

/** The pack whose three parts are exactly `look`, if any. */
export function packOf(look: Look): DesignPack | null {
  return (
    DESIGN_PACKS.find(
      (pack) =>
        pack.primary === look.primary && pack.accent === look.accent && pack.background === look.background,
    ) ?? null
  );
}

/** The part of a pack a chat takes: all three, so choosing a pack replaces an earlier look. */
export const lookOfPack = (pack: DesignPack): Look => ({
  primary: pack.primary,
  accent: pack.accent,
  background: pack.background,
});

/** The CSS classes that carry a look on a chat's page: what `lookCss` writes rules for. */
export function lookClasses(look: Look): string[] {
  return [
    ...(look.primary ? [`look-primary-${look.primary}`] : []),
    ...(look.accent ? [`look-accent-${look.accent}`] : []),
  ];
}

/**
 * The rules that recolour one chat's page through the classes of `lookClasses`: own bubbles and the
 * suggested-action button take the accent, the page, its header and the cards take the tint.
 * `colors` holds each accent's RGB (0–255) as the desktop's palette defines it.
 */
export function lookCss(colors: Readonly<Record<AccentName, Rgb>>, dark: boolean): string {
  const scheme = dark ? 'dark' : 'light';
  const mix = (surface: keyof (typeof SURFACES)[typeof scheme], name: AccentName): string =>
    mixHex(SURFACES[scheme][surface], colors[name], TINT[scheme]);
  return ACCENT_NAMES.map((name) => {
    const [r, g, b] = colors[name];
    const accent = `rgb(${r},${g},${b})`;
    return `.look-accent-${name} .curlew-own, .look-accent-${name} button.suggested-action {
  background-image: none;
  background-color: ${accent};
  color: white;
}
toolbarview.look-primary-${name} { background-color: ${mix('window_bg_color', name)}; }
.look-primary-${name} headerbar { background-color: ${mix('headerbar_bg_color', name)}; }
.look-primary-${name} .curlew-surface { background-color: ${mix('window_bg_color', name)}; }`;
  }).join('\n');
}
