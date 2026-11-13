#!/usr/bin/env bash
#
# dev/screenshots.sh -- render the listing screenshots: EN/DE x light/dark, window alone.
#
#   dev/screenshots.sh [--build] [--only <motif>] [--lang en|de] [--scheme light|dark] [--check]
#
# Needs a built window bundle (`gjsify workspace curlew-cli build`, or pass --build). Uses a private
# synthetic index and config in a temp dir (app/scripts/demo-index.ts), never ~/.config/curlew or the
# real index. Output: docs/screenshots/<motif>.<lang>.<scheme>.png. See docs/design/ui.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HEADLESS="${HEADLESS_RUN:-$HOME/Projekte/werkstatt/scripts/headless-run}"
OUT="$ROOT/docs/screenshots"
DEMO="${CURLEW_SHOTS_DEMO:-/tmp/curlew-demo-shots}"

# motif | window size (logical) | extra environment
MOTIFS=(
  "conversations|900x640|"
  "conversation|900x640|CURLEW_WINDOW_OPEN=c1"
  "conversation-narrow|360x740|CURLEW_WINDOW_OPEN=c1"
  "conversations-narrow|360x740|"
  "contact|900x640|CURLEW_WINDOW_OPEN=c1 CURLEW_WINDOW_OPEN_CONTACT=1"
  "preferences|900x640|CURLEW_WINDOW_OPEN_PREFERENCES=1"
  "accounts|900x640|CURLEW_WINDOW_OPEN_ACCOUNTS=1"
  "protocols|900x640|CURLEW_WINDOW_OPEN_PROTOCOLS=1"
  "agent-access|900x640|CURLEW_WINDOW_OPEN_ACCESS=1"
  "welcome|360x740|CURLEW_WINDOW_OPEN_WELCOME=1"
)

BUILD=0 CHECK=0 ONLY="" LANGS=(en de) SCHEMES=(light dark)
while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD=1 ;;
    --check) CHECK=1 ;;
    --only) ONLY="${2:?}"; shift ;;
    --lang) LANGS=("${2:?}"); shift ;;
    --scheme) SCHEMES=("${2:?}"); shift ;;
    -h|--help) sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

expected=()
for m in "${MOTIFS[@]}"; do
  name="${m%%|*}"
  [ -z "$ONLY" ] || [ "$ONLY" = "$name" ] || continue
  for l in "${LANGS[@]}"; do for s in "${SCHEMES[@]}"; do expected+=("$name.$l.$s.png"); done; done
done

if [ "$CHECK" = 1 ]; then
  rc=0
  for f in "${expected[@]}"; do [ -s "$OUT/$f" ] || { echo "missing: $f" >&2; rc=1; }; done
  exit "$rc"
fi

cd "$ROOT"
[ "$BUILD" = 0 ] || gjsify workspace curlew-cli build >/dev/null
[ -f app/dist/window.gjs.mjs ] || { echo "no app/dist/window.gjs.mjs: run with --build" >&2; exit 1; }
rm -rf "$DEMO"
(cd app && node --experimental-strip-types scripts/demo-index.ts "$DEMO" >/dev/null)
mkdir -p "$OUT"

for m in "${MOTIFS[@]}"; do
  IFS='|' read -r name size extra <<<"$m"
  [ -z "$ONLY" ] || [ "$ONLY" = "$name" ] || continue
  for l in "${LANGS[@]}"; do
    locale="en_US.UTF-8"; [ "$l" = de ] && locale="de_DE.UTF-8"
    for s in "${SCHEMES[@]}"; do
      dark=(); [ "$s" = dark ] && dark=(--dark)
      file="$OUT/$name.$l.$s.png"
      # headless-run exits 1 even when the image is written, so the file is the verdict.
      rm -f "$file"
      # shellcheck disable=SC2086
      env CURLEW_DB_PATH="$DEMO/index.db" CURLEW_CONFIG="$DEMO/config.json" \
        CURLEW_PREVIEWS_DIR="$DEMO/previews" CURLEW_WINDOW_SIZE="$size" \
        CURLEW_NO_HOST_ACCOUNTS=1 $extra \
        LC_ALL="$locale" LANG="$locale" LANGUAGE="$l" \
        timeout 170 "$HEADLESS" --size 1300x1000 "${dark[@]}" --window-shot "$file" -- \
        gjsify run app/dist/window.gjs.mjs >/dev/null 2>&1 || true
      if [ -s "$file" ]; then
        magick "$file" -strip "$file"
        echo "ok   $(basename "$file")"
      else
        echo "FAIL $(basename "$file")" >&2
      fi
    done
  done
done
dev/screenshots.sh --check ${ONLY:+--only "$ONLY"}
