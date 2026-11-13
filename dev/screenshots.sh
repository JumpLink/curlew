#!/usr/bin/env bash
#
# dev/screenshots.sh -- render the listing screenshots on the demo data: EN/DE x light/dark, window alone.
#
#   dev/screenshots.sh [--build] [--only <motif>] [--lang en|de] [--scheme light|dark] [--check]
#
# Needs a built window bundle (`gjsify workspace curlew-cli build`, or pass --build). Runs
# `CURLEW_DEMO=1` (app/src/core/demo/) on scratch copies in a temp dir, never ~/.config/curlew or the
# real index. Output: docs/screenshots/<motif>.<lang>.<scheme>.png. See docs/screenshots/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HEADLESS="${HEADLESS_RUN:-$HOME/Projekte/werkstatt/scripts/headless-run}"
OUT="$ROOT/docs/screenshots"
WORK="${CURLEW_SHOTS_DEMO:-/tmp/curlew-demo-shots}"

# motif | window size (logical) | data set | extra environment
# data set: demo = the demo data, off = same with every protocol and switch off,
#           paused = the demo with the WhatsApp account paused,
#           empty = no accounts, no index (the Accounts dialog with its daemon banner).
MOTIFS=(
  "conversations|900x640|demo|"
  "conversation|900x640|demo|CURLEW_WINDOW_OPEN=c1"
  "conversation-narrow|360x740|demo|CURLEW_WINDOW_OPEN=c1"
  "conversations-narrow|360x740|demo|"
  "contact|900x700|demo|CURLEW_WINDOW_OPEN=c1 CURLEW_WINDOW_OPEN_CONTACT=1"
  "group|900x700|demo|CURLEW_WINDOW_OPEN=c4 CURLEW_WINDOW_OPEN_CONTACT=1"
  "preferences|900x640|demo|CURLEW_WINDOW_OPEN_PREFERENCES=1"
  "preferences-off|900x640|off|CURLEW_WINDOW_OPEN_PREFERENCES=1"
  "accounts|900x640|demo|CURLEW_WINDOW_OPEN_ACCOUNTS=1"
  "accounts-off|900x640|off|CURLEW_WINDOW_OPEN_ACCOUNTS=1"
  "accounts-empty|900x640|empty|CURLEW_WINDOW_OPEN_ACCOUNTS=1"
  "protocols|900x640|demo|CURLEW_WINDOW_OPEN_PROTOCOLS=1"
  "protocols-off|900x640|off|CURLEW_WINDOW_OPEN_PROTOCOLS=1"
  "agent-access|900x640|demo|CURLEW_WINDOW_OPEN_ACCESS=1"
  "welcome|360x740|empty|CURLEW_WINDOW_OPEN_WELCOME=1"
  "welcome-delta-chat|360x740|demo|CURLEW_WINDOW_OPEN_WELCOME=delta-chat"
  "email-chat|900x640|demo|CURLEW_WINDOW_OPEN=c3"
  "composer-emoji|900x640|demo|CURLEW_WINDOW_OPEN=c1 CURLEW_WINDOW_OPEN_EMOJI=1"
  "contact-merged|900x700|demo|CURLEW_WINDOW_OPEN=c3 CURLEW_WINDOW_OPEN_CONTACT=1"
  "account-paused|900x640|paused|CURLEW_WINDOW_OPEN_ACCOUNT=whatsapp/whatsapp-demo1"
)

BUILD=0 CHECK=0 ONLY="" LANGS=(en de) SCHEMES=(light dark)
while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD=1 ;;
    --check) CHECK=1 ;;
    --only) ONLY="${2:?}"; shift ;;
    --lang) LANGS=("${2:?}"); shift ;;
    --scheme) SCHEMES=("${2:?}"); shift ;;
    -h|--help) sed -n '3,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# Fresh data on every run, so the list times ("4 min ago") are relative to now.
rm -rf "$WORK"
mkdir -p "$WORK/demo" "$WORK/off" "$WORK/paused" "$WORK/empty" "$OUT"
(cd app && node --experimental-strip-types scripts/demo-index.ts "$WORK/demo" >/dev/null)
cp -a "$WORK/demo/." "$WORK/off/"
jq '.backends |= with_entries(.value.enabled = false)
    | .ui |= (.ai = false | .notifications = "off" | .showAllEmails = false)
    | .agentAccess.rules = []' "$WORK/demo/config.json" >"$WORK/off/config.json.new"
mv "$WORK/off/config.json.new" "$WORK/off/config.json"
cp -a "$WORK/demo/." "$WORK/paused/"
jq '.disabledAccounts = ["whatsapp/whatsapp-demo1"]' "$WORK/demo/config.json" >"$WORK/paused/config.json"
echo '{"ui":{"welcomeDone":true}}' >"$WORK/empty/config.json"

for m in "${MOTIFS[@]}"; do
  IFS='|' read -r name size data extra <<<"$m"
  [ -z "$ONLY" ] || [ "$ONLY" = "$name" ] || continue
  # The welcome screen only shows on a first start.
  config="$WORK/$data/config.json"
  if [ "$name" = welcome ]; then
    mkdir -p "$WORK/empty"; echo "{}" >"$WORK/empty/welcome.json"; config="$WORK/empty/welcome.json"
  fi
  if [ "$data" = empty ]; then
    # Not demo mode: an empty index and config, so there is nothing to list.
    dataenv=(CURLEW_DB_PATH="$WORK/empty/index.db" CURLEW_CONFIG="$config"
      CURLEW_PREVIEWS_DIR="$WORK/empty/previews" CURLEW_AVATARS_DIR="$WORK/empty/avatars"
      CURLEW_DATA_DIR="$WORK/empty" CURLEW_SECRETS_DIR="$WORK/empty/secrets")
  else
    dataenv=(CURLEW_DEMO=1 CURLEW_DEMO_DIR="$WORK/$data")
  fi
  for l in "${LANGS[@]}"; do
    locale="en_US.UTF-8"; [ "$l" = de ] && locale="de_DE.UTF-8"
    for s in "${SCHEMES[@]}"; do
      dark=(); [ "$s" = dark ] && dark=(--dark)
      file="$OUT/$name.$l.$s.png"
      # headless-run exits 1 even when the image is written, so the file is the verdict. No
      # CURLEW_WINDOW_QUIT_AFTER_MS: it would end the window before the shot delay is over.
      rm -f "$file"
      # shellcheck disable=SC2086
      env "${dataenv[@]}" CURLEW_WINDOW_SIZE="$size" CURLEW_NO_HOST_ACCOUNTS=1 CURLEW_DEMO_QUIET=1 $extra \
        LC_ALL="$locale" LANG="$locale" LANGUAGE="$l" \
        timeout 170 "$HEADLESS" --size 1300x1000 --shot-delay 10 "${dark[@]}" --window-shot "$file" -- \
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
