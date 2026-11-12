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

/** What lies behind the messages of a conversation: our own doodles, or nothing. */
export const BACKGROUND_CHOICES = ['doodles', 'none'] as const;
export type BackgroundChoice = (typeof BACKGROUND_CHOICES)[number];

export function isBackgroundChoice(value: string): value is BackgroundChoice {
  return (BACKGROUND_CHOICES as readonly string[]).includes(value);
}

/** An unset or unknown value is the default, the doodles. */
export function backgroundToShow(choice: string | undefined): BackgroundChoice {
  return choice !== undefined && isBackgroundChoice(choice) ? choice : 'doodles';
}
