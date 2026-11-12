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
2. **Chat background.** A setting `ui.chatBackground`: `doodles` (the default), `dots`, `waves` or `none` (see 6). The pattern is an SVG tile that carries no colour of its own: it is
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

6. **Design packs, patterns and a look per chat (addendum).** The background is managed with the
   colours in one place: the preferences' Appearance page leads with a **Design** row. A pack is a
   named triple of primary colour, accent colour and background (`curlew`, `forest`, `dusk`,
   `sunrise`, `rose`, `graphite`; `curlew` is what an untouched install shows). Picking one writes
   the three settings; the row reads "Custom" whenever they match no pack. The patterns are the
   doodles, a staggered dot grid and waves, all one tile in the foreground colour, or none.
   A direct chat with a contact page can **differ from the app**: `contactChoices` gains optional
   `primary`, `accent` and `background`, set on the contact page (a pack, or the accent and the
   background alone). The look is applied through CSS classes on the open chat's page
   (`look-primary-<name>`, `look-accent-<name>`) with rules written once per colour, never a provider per
   chat. For that the person's own bubbles carry `curlew-own` and the others `curlew-surface`,
   not both: a scoped tint must not repaint own bubbles. Groups and Note to self have no contact
   page, hence no look of their own yet.

## Consequences

- Three small PRs: accent and settings, background, floating bars. Each leaves the window working.
- Verified at 360 px and in dark mode before merging each.
- The tile is generated art we own; adding mascots later needs a licence and source line per motif.

## Amendment 2026-11-12: a pattern per design pack, and mascots

Each pack now has its own tile (`forest`, `dusk`, `sunrise`, `rose`, `graphite`; `curlew` keeps the
doodles). The background setting gains those five ids next to `doodles`, `dots`, `waves` and `none`,
so old configs read as before. A pack's background is the matching id; the person can still pick any
pattern. All tiles are thirteen own line drawings on the doodles' slots (`chat-motifs.ts`), one colour,
no colour of their own, no traced or embedded artwork.

The earlier "no mascots" stance is refined: we draw our own loose homages and keep only what the terms
allow. Sources read on 2026-11-12:

| Motif | Origin | Licence / terms | Decision |
|---|---|---|---|
| Penguin (dusk) | Tux by Larry Ewing, 1996 | Wikipedia quotes his terms: use and modification allowed if you acknowledge Larry Ewing and The GIMP when asked; his own page was unreachable (404) | Generic own-drawn round penguin, not a copy of Tux. Credit: Tux by Larry Ewing, made with the GIMP. |
| Crab (sunrise) | Ferris, rustacean.net | CC0 (Karen Rustad Tölva waived all rights); the Rust logo itself is CC-BY plus trademark | Own-drawn crab in Ferris's spirit; no credit needed, we give one anyway. |
| GNOME foot | GNOME Foundation | Trademark guidelines: no logos without written permission, "do not create your own logos to represent GNOME", do not alter marks | Dropped. A seashell stands in on the beach. |
| TypeScript | Microsoft branding page | Logo not to be used in your own application or product | Dropped. |
| GTK | gtk.org | Legal page unreachable (404), terms unverified | Dropped. |

Everything else (leaves, trees, mushrooms, moon, stars, clouds, sun, palm, waves, hearts, petals,
flowers, geometry) is generic imagery. Adding another mascot needs a row here first.
