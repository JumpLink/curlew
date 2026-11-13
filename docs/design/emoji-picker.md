# Emoji picker

`app/src/window/emoji-picker.ts` replaces `Gtk.EmojiChooser`, which built about 1800 buttons on
its first opening and blocked the main loop for about 1.2 s. The popover now holds a search entry,
a `Gtk.GridView` (only the cells on screen exist), a row of jump buttons (one per group) and a
"Recent" row of the last 24 picks (`ui.recentEmoji` in the config). Arrow keys move in the grid,
Enter or a click picks, Down in the search entry goes to the grid, Escape closes. Every cell has
an accessible label and a tooltip with the emoji's name, in German when the locale is German.

The picker is built when it is first shown. `createEmojiPopover(onPick, recent?)` is the reusable
entry point; the composer uses it, and a reaction picker should use it behind the fixed quick list.

## Data

`app/src/window/emoji-data.ts` is generated, not edited:

    zcat emoji-test.txt.gz > /tmp/emoji-test.txt
    python3 -I dev/gen-emoji-data.py /tmp/emoji-test.txt <cldr>/common > app/src/window/emoji-data.ts

Emoji and groups come from Unicode `emoji-test.txt` (fully-qualified entries, skin-tone variants
left out); English and German names and search words come from the CLDR annotations
(`annotations` and `annotationsDerived`, `en` and `de`). Both are © Unicode, Inc., under the
Unicode License v3 (SPDX `Unicode-3.0`); the generated file says so in its header. The model
(`emoji-model.ts`) matches every word of a query against both languages.

## Measuring

`CURLEW_DEBUG_STALL=1` with `CURLEW_WINDOW_OPEN=c3 CURLEW_WINDOW_OPEN_EMOJI=1` logs
`open emoji picker`. Further stall hooks: `CURLEW_WINDOW_OPEN_BUBBLE=1` (newest bubble's context
menu) and `CURLEW_WINDOW_OPEN_MENU=1` (primary menu).
