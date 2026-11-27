#!/usr/bin/env bash
#
# dev/headless.sh -- run a command on a private, invisible screen of its own.
#
#   dev/headless.sh [--size WxH] -- <command> [args...]
#
# A `mutter --headless` with one virtual monitor and a private D-Bus session, torn down again
# afterwards: the command gets a real compositor and the real GTK, but opens no window on anybody's
# desktop and reaches none of the person's running apps over the bus.
#
# WHY IT IS IN THE REPO. `dev/perf.sh` is a CI gate (#501), so the container has to be able to run
# it, and `dev/screenshots.sh` borrows the richer `headless-run` from a checkout that only exists
# on Pascal's workstation. This is the part a window needs and nothing more -- no screenshots, no
# monitor scaling. Set `HEADLESS_RUN` to use that script instead.
#
# Needs `mutter`, `dbus-run-session` and a software renderer (`mesa-dri-drivers`). GSettings go to
# the in-memory backend, so the command sees the platform defaults rather than the person's dconf.
set -euo pipefail

SIZE=1300x1000
while [ $# -gt 0 ]; do
  case "$1" in
    --size) SIZE="${2:?--size needs WxH}"; shift 2 ;;
    -h|--help) sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || { echo "usage: dev/headless.sh [--size WxH] -- <command> [args...]" >&2; exit 2; }
command -v mutter >/dev/null || { echo "dev/headless.sh: mutter not found" >&2; exit 2; }
command -v dbus-run-session >/dev/null || { echo "dev/headless.sh: dbus-run-session not found" >&2; exit 2; }

# A container has no logind, so it has no XDG_RUNTIME_DIR either -- and that is where the
# compositor puts its socket. One of our own, if the session has none.
if [ -z "${XDG_RUNTIME_DIR:-}" ] || [ ! -d "${XDG_RUNTIME_DIR}" ]; then
  XDG_RUNTIME_DIR="$(mktemp -d)"
  chmod 700 "$XDG_RUNTIME_DIR"
  export XDG_RUNTIME_DIR
fi

export HEADLESS_SIZE="$SIZE"
export HEADLESS_DISPLAY="curlew-headless-$$"
export HEADLESS_LOG="$(mktemp -t curlew-headless.XXXXXX.log)"
export GSETTINGS_BACKEND=memory

set +e
dbus-run-session -- bash -c '
  set -u
  mutter --headless --wayland --no-x11 --wayland-display="$HEADLESS_DISPLAY" \
    --virtual-monitor "$HEADLESS_SIZE" >"$HEADLESS_LOG" 2>&1 &
  M=$!
  trap "kill $M 2>/dev/null; wait $M 2>/dev/null" EXIT
  for _ in $(seq 150); do
    [ -S "$XDG_RUNTIME_DIR/$HEADLESS_DISPLAY" ] && break
    kill -0 $M 2>/dev/null || { echo "dev/headless.sh: mutter exited" >&2; cat "$HEADLESS_LOG" >&2; exit 125; }
    sleep 0.1
  done
  [ -S "$XDG_RUNTIME_DIR/$HEADLESS_DISPLAY" ] ||
    { echo "dev/headless.sh: no compositor socket" >&2; tail -40 "$HEADLESS_LOG" >&2; exit 125; }
  unset DISPLAY
  export WAYLAND_DISPLAY="$HEADLESS_DISPLAY" GDK_BACKEND=wayland GTK_A11Y=none
  "$@"
' headless "$@"
RC=$?
set -e

[ "$RC" = 125 ] || rm -f "$HEADLESS_LOG"
[ "$RC" != 125 ] || echo "dev/headless.sh: mutter log $HEADLESS_LOG" >&2
exit "$RC"
