# Android port — what the NativeScript target does not cover yet

Measured, not estimated: `report-target-gap` from gjsify (commit `3b4b476b0d`) run against
`app/` on 2026-11-14. It holds every `gi://` use in the sources against the **pure-JS NativeScript
barrel** (`@gjsify/adwaita-nativescript`). Curlew builds its windows in code and has no Blueprint
templates, so only the source half applies. The work order is the roadmap in the werkstatt hub
(phases P5–P6).

Reproduce (from a gjsify checkout):

```sh
node scripts/report-target-gap.mjs <path-to>/curlew/app --json
```

**Read this caveat first.** The barrel is the pure-JS twin. On Android the default engine is real
GObject/Gio/GLib (gjsify ADR 0110), so the `GLib.*`, `Gio.*` and `Gdk.*` data rows may already be
satisfied by the real engine. That is **unverified** until a device run. The widget and enum rows
are real gaps of the barrel itself.

## Totals

| | |
|---|---|
| Blueprints | 0 |
| Source files with `gi://` | 41, of which 7 are clean on NativeScript |
| Namespaces without any NativeScript renderer | `Gst` (voice recorder only), `Pango`, `GdkPixbuf`, `Gsk` |

## Namespaces without a renderer

| Namespace | Members used | Where |
|---|---|---|
| `Gst` | `ElementFactory` ×7, `State` ×3, `MessageType` ×2, `Caps`, `Event`, `init`, `Pipeline`, `SECOND`, `StateChangeReturn` | `src/window/voice-recorder.ts` only |
| `Pango` | `EllipsizeMode` ×10, `WrapMode` ×3 | attachment, composer and conversation views |
| `GdkPixbuf` | `Pixbuf` ×4, `InterpType` | image handling |
| `Gsk` | `ColorStop` ×3, `MaskMode` | drawing |

The voice recorder is a v1 non-goal; it needs a different capture path on Android anyway.

## Enums the barrel does not export as values

The widgets take string forms, so `Gtk.Orientation.VERTICAL` in app code is `undefined`.

| Member | Uses / files |
|---|---|
| `Gtk.Align` | 87 / 19 |
| `Gtk.Orientation` | 35 / 13 |
| `Gtk.AccessibleProperty` | 22 / 9 |
| `Gtk.PropagationPhase` | 7 / 4 |
| `Adw.ResponseAppearance` | 6 / 4 |
| `Gtk.SelectionMode` | 6 / 3 |
| `Gtk.Justification` | 5 / 3 |
| `Gtk.Overflow` | 5 / 3 |
| `Gdk.ModifierType` | 5 / 4 |
| `Gtk.EventSequenceState`, `Gtk.ContentFit`, `Gtk.StackTransitionType`, `GObject.BindingFlags`, `Gtk.WrapMode`, `Gtk.AccessibleRole`, `Gtk.SizeRequestMode`, `Gdk.DragAction`, `Gdk.MemoryFormat` | 1–3 each |

## Widgets, controllers and list machinery

| Group | Members (uses / files) |
|---|---|
| Rows and popups | `Gtk.ListBoxRow` (7/3) · `Gtk.Popover` (6/3) · `Adw.PreferencesRow` (1/1) |
| Gestures | `Gtk.GestureClick` (6/4) · `Gtk.GestureLongPress` (2/2) · `Gtk.GestureSwipe` · `Gtk.Gesture` · `Gtk.DropTarget` |
| Media | `Gtk.MediaFile` (3/3) · `Gtk.Picture` (3/3) · `Gtk.Video` · `Gdk.Texture` (4/4) · `Gdk.MemoryTexture` · `Gdk.FileList` · `Gtk.Snapshot` · `Graphene.Rect` (3/2) |
| Input | `Gtk.SearchEntry` (3/3) · `Gtk.SearchBar` · `Gtk.PasswordEntry` · `Gtk.Scale` · `Gtk.Editable` |
| Layout | `Gtk.FlowBox` · `Gtk.Fixed` · `Gtk.LinkButton` · `Gtk.FileLauncher` · `Gtk.CssStyleChange` |
| Lists | `Gtk.ListView` · `Gtk.GridView` · `Gtk.NoSelection` (2/2) · `Gtk.SignalListItemFactory` (2/2) · `Gtk.ListScrollFlags` · `Gtk.INVALID_LIST_POSITION` |
| Adaptive | `Adw.Breakpoint` (1/1) · `Adw.BreakpointCondition` (1/1) · `Adw.accent_color_to_rgba` (3/1) · `Adw.accent_color_to_standalone_rgba` |

`Gtk.ListView`, `Gtk.GridView` and the list factories appear in only two files
(`window/emoji-picker.ts`, `window/new-conversation.ts`), so they are small and optional for v1.
The roadmap keeps dynamic lists programmatic (no Blueprint).

## Platform (`Gio` / `GLib` / `Gdk`; check against the real engine)

- D-Bus: `Gio.bus_get_sync` (4/4), `Gio.BusType`, `Gio.bus_own_name_on_connection`,
  `Gio.bus_watch_name_on_connection`, `Gio.bus_unown_name`, `Gio.DBusNodeInfo`, `Gio.DBusCallFlags`,
  `Gio.DBusSignalFlags`, `GLib.VariantType` (5/4). Live updates (ADR 0007) use this; v1 drops it.
- Processes: `Gio.Subprocess`, `Gio.SubprocessFlags`
- Files and types: `Gio.FileMonitor*`, `Gio.FileQueryInfoFlags`, `Gio.FileType`, `Gio.FileCopyFlags`,
  `Gio.content_type_*`, `GLib.file_test` + `GLib.FileTest`, `GLib.path_get_basename` (4/4),
  `GLib.path_get_dirname`, `GLib.filename_from_uri`, `GLib.format_size`
- Main loop and misc: `GLib.MainLoop` (4/4), `GLib.get_monotonic_time` (7/2), `GLib.setenv`,
  `GLib.uuid_string_random`, `GLib.markup_escape_text`, `Gio.AppInfoCreateFlags`
- Keys and buttons: `Gdk.BUTTON_PRIMARY`, `Gdk.BUTTON_SECONDARY`, `Gdk.KEY_*`

## What the report does not measure

The blockers that decide Curlew on Android are not GTK API: `node:net`, `node:tls`, `node:sqlite`,
`node:fs` and `child_process` are `"none"` for NativeScript in gjsify's runtime manifest, and TLS
for Gio needs glib-networking and OpenSSL in the Android sysroot (gjsify ADR 0117 and 0134, stage 2).
Those are phases P2 and P5 of the roadmap, not rows in this table.
