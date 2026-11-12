#!/bin/sh
# Install the packaging files into an XDG data directory.
#
# Why this exists at all, when `gjsify ship` builds a real `.deb`/`.rpm`/Flatpak:
# `ship` packs a payload, it does not put an app into the desktop of the machine
# running it. The window needs the files *in place*: GTK resolves the window icon
# by NAME (`app/src/window/main.ts`: `Gtk.Window.set_default_icon_name(APP_ID)`,
# with `addSourceTreeIcons` as the source-tree stand-in), and the shell matches a
# window to its launcher only through an INSTALLED `.desktop` — under Wayland via
# the application id, elsewhere via `StartupWMClass`. This is the "does it show
# up in the shell" step, not a package; lotsman's `scripts/install-packaging.sh`
# is the pattern.
#
# `PREFIX` decides where. Default is the per-user XDG data dir, which needs no
# root and which a package install overrides; `DESTDIR` (packaging convention) is
# honoured so a distribution can reuse this as a staging step.
#
# Deliberately NOT here: the `Exec=curlew window` line calls whatever `curlew`
# is on PATH, and the systemd user units are the machine's own wiring
# (`curlew setup`, README "Receiving daemon") — this script never writes
# `~/.local/bin/curlew` and never touches units.
set -eu

: "${DESTDIR:=}"
: "${PREFIX:=${XDG_DATA_HOME:-$HOME/.local/share}}"
root="${DESTDIR}${PREFIX}"
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# `-D` so the hicolor and applications subtrees are created in one go; `-m` fixed
# rather than taken from the umask, because an icon another user cannot read is an
# icon the icon theme skips.
install -Dm644 "$here/app/data/eu.jumplink.curlew.desktop" \
	"$root/applications/eu.jumplink.curlew.desktop"
install -Dm644 "$here/app/data/eu.jumplink.curlew.metainfo.xml" \
	"$root/metainfo/eu.jumplink.curlew.metainfo.xml"
install -Dm644 "$here/app/data/icons/hicolor/scalable/apps/eu.jumplink.curlew.svg" \
	"$root/icons/hicolor/scalable/apps/eu.jumplink.curlew.svg"
install -Dm644 "$here/app/data/icons/hicolor/symbolic/apps/eu.jumplink.curlew-symbolic.svg" \
	"$root/icons/hicolor/symbolic/apps/eu.jumplink.curlew-symbolic.svg"
for protocol_icon in "$here"/app/data/icons/hicolor/scalable/apps/curlew-protocol-*.svg; do
	install -Dm644 "$protocol_icon" "$root/icons/hicolor/scalable/apps/$(basename "$protocol_icon")"
done

# The two caches are what a desktop shell actually reads. Both tools are optional:
# without `update-desktop-database` the entry still launches, it just does not
# re-sort until something else rebuilds the cache — so a missing tool is a note,
# not a failure. `gtk-update-icon-cache` is per-theme and only the hicolor dir
# changed, hence the argument.
if command -v update-desktop-database >/dev/null 2>&1; then
	update-desktop-database -q "$root/applications"
else
	echo "update-desktop-database not found: launcher works, menu order may lag" >&2
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
	gtk-update-icon-cache -qtf "$root/icons/hicolor" || :
else
	echo "gtk-update-icon-cache not found: icons are found by path, cache stays stale" >&2
fi

echo "installed desktop entry, metainfo and icons under $root"
echo "Exec=curlew window calls the curlew on PATH — this install does NOT create it (README.md, 'Install and run')"
