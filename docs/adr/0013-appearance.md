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

1. **Accent.** A setting `ui.accentColor`: `default` (Curlew's own blue), `system`, or one of the
   Adwaita accent names (`blue`, `teal`, `green`, `yellow`, `orange`, `red`, `pink`, `purple`,
   `slate`). The default is Curlew's blue: it matches Signal, Telegram and WhatsApp, reads in light
   and dark, and is calm. It is applied through `Adw.StyleManager` where libadwaita supports an
   accent override, otherwise through the `@accent_*` colour variables, never per widget.
2. **Chat background.** A setting `ui.chatBackground`: `doodles` (the default), `plain`, or `none`. The pattern is an SVG tile that carries no colour of its own: it is
   drawn in `currentColor` at a few percent opacity, so it follows light/dark and the accent.
   The motifs are our own line drawings (a curlew, an envelope, a paper plane, a gear, a terminal,
   a speech bubble). Real mascots are not used: Tux and Wilber ask for attribution or share-alike,
   Blender, KDE and others are marks, and Telegram's `pattern.svg` is not ours to copy.
3. **Floating bars.** In the conversation view only, the header and the composer float over the
   history (`AdwToolbarView` with `extend_content_to_top_edge` / `extend_content_to_bottom_edge`,
   `top_bar_style` / `bottom_bar_style` raised). The history gets matching scroll padding so the
   first and last message are never hidden. The contact list keeps its plain bars.
4. **Where it lives.** One Appearance group in the preferences dialog (accent row, background row);
   a `ThemeService` in `app/src/window/` owns the provider, as in Learn6502. German strings from the
   first commit.

## Consequences

- Three small PRs: accent and settings, background, floating bars. Each leaves the window working.
- Verified at 360 px and in dark mode before merging each.
- The tile is generated art we own; adding mascots later needs a licence and source line per motif.
