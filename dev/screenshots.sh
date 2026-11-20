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

# Window sizes: 900x640 for the chat motifs, 968x668 for the dialog and page motifs, whose content is
# taller; 360x740 for phone width. The PNG keeps the rounded corners and the 16 px shadow on a
# transparent background, so every wide file stays within Flathub's 1000x700. The empty-state motifs use the
# phone width, so the Accounts dialog fills the window and does not clip the page behind it.
# motif | window size (logical) | data set | extra environment
# data set: demo = the demo data, off = same with every protocol and switch off,
#           paused = the demo with the WhatsApp account paused,
#           empty = no accounts, no index (the Accounts dialog with its daemon banner).
MOTIFS=(
  "conversations|900x640|demo|CURLEW_WINDOW_OPEN=c1"
  "conversation|900x640|demo|CURLEW_WINDOW_OPEN=c2"
  "conversation-narrow|360x740|demo|CURLEW_WINDOW_OPEN=c1"
  "conversations-narrow|360x740|demo|"
  "contact|968x668|demo|CURLEW_WINDOW_OPEN=c1 CURLEW_WINDOW_OPEN_CONTACT=1"
  "group|968x668|demo|CURLEW_WINDOW_OPEN=c4 CURLEW_WINDOW_OPEN_CONTACT=1"
  "preferences|968x668|demo|CURLEW_WINDOW_OPEN_PREFERENCES=1"
  "preferences-off|968x668|off|CURLEW_WINDOW_OPEN_PREFERENCES=1"
  "accounts|968x668|demo|CURLEW_WINDOW_OPEN_ACCOUNTS=1"
  "accounts-off|360x740|off|CURLEW_WINDOW_OPEN_ACCOUNTS=1"
  "accounts-empty|360x740|empty|CURLEW_WINDOW_OPEN_ACCOUNTS=1"
  "protocols|968x668|demo|CURLEW_WINDOW_OPEN_PROTOCOLS=1"
  "protocols-off|968x668|off|CURLEW_WINDOW_OPEN_PROTOCOLS=1"
  "agent-access|968x668|demo|CURLEW_WINDOW_OPEN_ACCESS=1"
  "welcome|360x740|empty|CURLEW_WINDOW_OPEN_WELCOME=1"
  "welcome-delta-chat|360x740|demo|CURLEW_WINDOW_OPEN_WELCOME=delta-chat"
  "email-chat|900x640|demo|CURLEW_WINDOW_OPEN=c3"
  "composer-emoji|900x640|demo|CURLEW_WINDOW_OPEN=c1 CURLEW_WINDOW_OPEN_EMOJI=1"
  "reactions|900x640|demo|CURLEW_WINDOW_OPEN=c25"
  "reactions-narrow|360x740|demo|CURLEW_WINDOW_OPEN=c25"
  "contact-merged|968x668|demo|CURLEW_WINDOW_OPEN=c3 CURLEW_WINDOW_OPEN_CONTACT=1"
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

# Fresh data on every run, so the list times ("4 min ago") are relative to now. One tree per language:
# the demo text is generated in the language of the shot.
rm -rf "$WORK"
mkdir -p "$OUT"
for l in "${LANGS[@]}"; do
  W="$WORK/$l"
  mkdir -p "$W/demo" "$W/off" "$W/paused" "$W/empty"
  (cd app && node --experimental-strip-types scripts/demo-index.ts "$W/demo" "$l" >/dev/null)
  cp -a "$W/demo/." "$W/off/"
  jq '.backends |= with_entries(.value.enabled = false)
      | .ui |= (.ai = false | .notifications = "off" | .showAllEmails = false)
      | .agentAccess.rules = []' "$W/demo/config.json" >"$W/off/config.json.new"
  mv "$W/off/config.json.new" "$W/off/config.json"
  cp -a "$W/demo/." "$W/paused/"
  jq '.disabledAccounts = ["whatsapp/whatsapp-demo1"]' "$W/demo/config.json" >"$W/paused/config.json"
  echo '{"ui":{"welcomeDone":true}}' >"$W/empty/config.json"
done

# One headless session for the whole run: the jobs go to dev/screenshots-session.sh, which waits for
# a stable frame per shot instead of a fixed delay. Light and dark share the session.
JOBS="$WORK/jobs.tsv"
: >"$JOBS"
files=()
for m in "${MOTIFS[@]}"; do
  IFS='|' read -r name size data extra <<<"$m"
  [ -z "$ONLY" ] || [ "$ONLY" = "$name" ] || continue
  for l in "${LANGS[@]}"; do
    W="$WORK/$l"
    # The welcome screen only shows on a first start.
    config="$W/$data/config.json"
    if [ "$name" = welcome ]; then
      echo "{}" >"$W/empty/welcome.json"; config="$W/empty/welcome.json"
    fi
    if [ "$data" = empty ]; then
      # Not demo mode: an empty index and config, so there is nothing to list.
      dataenv="CURLEW_DB_PATH=$W/empty/index.db CURLEW_CONFIG=$config CURLEW_PREVIEWS_DIR=$W/empty/previews CURLEW_AVATARS_DIR=$W/empty/avatars CURLEW_DATA_DIR=$W/empty CURLEW_SECRETS_DIR=$W/empty/secrets"
    else
      dataenv="CURLEW_DEMO=1 CURLEW_DEMO_DIR=$W/$data"
    fi
    locale="en_US.UTF-8"; [ "$l" = de ] && locale="de_DE.UTF-8"
    for s in "${SCHEMES[@]}"; do
      file="$OUT/$name.$l.$s.png"
      files+=("$file")
      # No CURLEW_WINDOW_QUIT_AFTER_MS: it would end the window before the shot is taken.
      printf '%s\t%s\t%s\n' "$file" "$s" "$dataenv CURLEW_WINDOW_SIZE=$size CURLEW_NO_HOST_ACCOUNTS=1 CURLEW_DEMO_QUIET=1 $extra LC_ALL=$locale LANG=$locale LANGUAGE=$l" >>"$JOBS"
    done
  done
done

# The session exits 0 even when a shot failed; the file is the verdict.
timeout 3600 "$HEADLESS" --size 1300x1000 -- "$ROOT/dev/screenshots-session.sh" "$JOBS" >/dev/null 2>&1 || true
for file in "${files[@]}"; do
  if [ -s "$file" ]; then
    # Keep the rounded corners and the shadow, so the window sits on any page background
    # (light or dark); trim only the empty margin around it.
    magick "$file" -alpha set -bordercolor none -border 1 -trim +repage -strip "$file"
    echo "ok   $(basename "$file")"
  else
    echo "FAIL $(basename "$file")" >&2
  fi
done
