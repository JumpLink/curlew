/** The accent choices of the window (ADR 0013); GTK-free so the config can validate them. */

/** The Adwaita accent names, in the order libadwaita lists them. */
export const ACCENT_NAMES = ['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'slate'] as const;
export type AccentName = (typeof ACCENT_NAMES)[number];

/** `default` is Curlew's own blue, `system` leaves the desktop's accent alone. */
export const ACCENT_CHOICES = ['default', 'system', ...ACCENT_NAMES] as const;
export type AccentChoice = (typeof ACCENT_CHOICES)[number];

export function isAccentChoice(value: string): value is AccentChoice {
  return (ACCENT_CHOICES as readonly string[]).includes(value);
}

/** The accent to impose, or null when the desktop's own stays. An unset or unknown value is `default`. */
export function accentToImpose(choice: string | undefined): AccentName | null {
  if (choice === 'system') return null;
  return (ACCENT_NAMES as readonly string[]).includes(choice ?? '') ? (choice as AccentName) : 'blue';
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
