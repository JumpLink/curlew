# ADR 0013 — appearance: accent, chat background, floating bars

- **Status:** Proposed (2026-11-11). Decided by Pascal in chat; the choices below are the agreed shape.
- **Scope:** `app` (window only). No store, protocol or daemon change.
- **Builds on:** the mobile-first, GNOME-HIG-first rule (no custom CSS for structure) and the Learn6502
  precedent (`ThemeService`, `AccentColorSelector`, one GSettings key `accent-color`).

## Context

Telegram and WhatsApp let the person choose a quiet, playful chat background and a colour. Curlew
follows the system accent, which on a red or purple desktop turns every highlight loud. The
conversation view also has opaque bars: the header and the composer take their own strips of the
screen, where Telegram lets the history scroll under them.

## Decisions

1. **Accent.** A setting `ui.accentColor`: `default` (Curlew's own teal), `system`, or one of the
   Adwaita accent names (`blue`, `teal`, `green`, `yellow`, `orange`, `red`, `pink`, `purple`,
   `slate`). The default is teal: GNOME's own default accent is blue, so a blue default would be
   indistinguishable from "no choice", and teal sits apart from WhatsApp's green and Telegram's
   purple while reading in light and dark. (It was blue until the own-bubble change.) It is applied
   through the `@accent_*` colour variables, never per widget. The accent also fills the person's
   own message bubbles, as in Telegram and WhatsApp; every message surface is opaque so the
   background doodles never shine through.
2. **Chat background.** A setting `ui.chatBackground`: `doodles` (the default) or `none`. The pattern is an SVG tile that carries no colour of its own: it is
   drawn in `currentColor` at a few percent opacity, so it follows light/dark and the accent.
   The motifs are our own line drawings (a curlew, an envelope, a paper plane, a gear, a terminal,
   a speech bubble). Real mascots are not used: Tux and Wilber ask for attribution or share-alike,
   Blender, KDE and others are marks, and Telegram's `pattern.svg` is not ours to copy.
3. **Floating composer.** In the conversation view only, the composer floats over the history
   (`AdwToolbarView` with `extend_content_to_bottom_edge`, the history keeps a bottom margin equal to
   the bar's height so the last message scrolls clear). The input row, the reply and edit bars, the
   file strip and the hint are cards, so they stay legible over the messages beneath. The header
   stays solid, as in Telegram: libadwaita draws a transparent bar over extended content, and a
   title running over message text is unreadable. The contact list keeps its plain bars.
4. **Where it lives.** One Appearance group in the preferences dialog (accent row, background row);
   a `ThemeService` in `app/src/window/` owns the provider, as in Learn6502. German strings from the
   first commit.

5. **Style, primary colour, accent colour (addendum).** The preferences follow Learn6502:
   `ui.colorScheme` (`system`, `light`, `dark`, through `Adw.StyleManager`), `ui.primaryColor` and
   `ui.accentColor`, each colour with an on/off switch and nine dots. The **primary colour** is a
   quiet tint over the window, header, sidebar, popover, dialog and view surfaces, mixed from
   libadwaita's own light and dark base colours (20 % and 26 %; a weaker tint read as another grey), so text contrast holds. It
   defaults to blue; `system` (switch off) means no tint. The **accent colour** stays the Adwaita
   accent (default teal, `system` = the desktop's). The two are separate on purpose: a blue tint
   with a blue accent would leave own bubbles and buttons indistinguishable from the surface.

## Consequences

- Three small PRs: accent and settings, background, floating bars. Each leaves the window working.
- Verified at 360 px and in dark mode before merging each.
- The tile is generated art we own; adding mascots later needs a licence and source line per motif.
