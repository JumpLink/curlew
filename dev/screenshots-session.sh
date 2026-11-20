#!/usr/bin/env bash
#
# dev/screenshots-session.sh <jobs-file> -- runs INSIDE one `headless-run` session (see
# dev/screenshots.sh) and renders every job on it, instead of one mutter per shot.
#
# Job line, tab separated: <out.png> <light|dark> <env words...>. The app is started per job, with
# the colour scheme set on it (ADW_DEBUG_COLOR_SCHEME), so light and dark share the session. The
# matte method is headless-run's own (black and white backdrop, scripts/lib/window-matte.py), but
# the fixed shot delay is replaced by waiting for a stable frame: two consecutive captures equal.
set -uo pipefail

LIB="${HEADLESS_RUN_LIB:?run this inside headless-run}"
JOBS="${1:?jobs file}"
SETTLE="${CURLEW_SHOTS_SETTLE:-3}"   # floor for the timed actions of the demo window (1.5 s, 2 s)
APPWAIT="${CURLEW_SHOTS_APPWAIT:-120}"
cd "$(dirname "$0")/.."

T=$(mktemp -d); A=""; B=""
kill_app() { [ -z "$A" ] || { kill -- -"$A" 2>/dev/null; wait "$A" 2>/dev/null; A=""; }; }
cleanup() { kill_app; [ -z "$B" ] || kill -- -"$B" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT

cap() { gjs -m "$(dirname "$0")/screenshots-capture.js" "$1" >/dev/null; }

echo black >"$T/colour"
setsid gjs -m "$LIB/window-shot.js" backdrop "$T/colour" "$T/ready" & B=$!
for _ in $(seq 100); do [ -e "$T/ready" ] && break; sleep 0.1; done
[ -e "$T/ready" ] || { echo "backdrop never mapped" >&2; exit 125; }

while IFS=$'\t' read -r file scheme envs; do
  rm -f "$file"
  echo black >"$T/colour"
  # shellcheck disable=SC2086
  setsid env $envs ADW_DEBUG_COLOR_SCHEME="prefer-$scheme" gjsify run app/dist/window.gjs.mjs >/dev/null 2>&1 & A=$!
  deadline=$(( $(date +%s) + APPWAIT ))
  ok=0
  until cap "$T/probe.png" && python3 "$LIB/window-matte.py" --probe "$T/probe.png"; do
    kill -0 "$A" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ] || { ok=1; break; }
    sleep 0.5
  done
  if [ "$ok" = 0 ]; then
    sleep "$SETTLE"
    cap "$T/black.png" || ok=1
    for _ in $(seq 20); do
      [ "$ok" = 0 ] || break
      cap "$T/next.png" || { ok=1; break; }
      if cmp -s "$T/black.png" "$T/next.png"; then break; fi
      mv "$T/next.png" "$T/black.png"
    done
  fi
  if [ "$ok" = 0 ]; then
    echo white >"$T/colour"; sleep 1
    cap "$T/white.png" && python3 "$LIB/window-matte.py" "$T/black.png" "$T/white.png" "$file" 1 >/dev/null 2>&1
  fi
  kill_app
  sleep 0.3
done <"$JOBS"
exit 0
