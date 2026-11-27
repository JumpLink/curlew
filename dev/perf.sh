#!/usr/bin/env bash
#
# dev/perf.sh -- measure whether the window stays responsive on a LARGE index (#541, #501).
#
#   dev/perf.sh [--build] [--small] [--keep] [--budget <ms>] [--out <dir>]
#
# Writes a synthetic index (app/scripts/perf-index.ts: made-up names, bodies and addresses --
# the real index is never an input), then plays four scenarios on it in one headless session and
# reports what each one cost against the 50 ms budget (the stall probe's own default,
# docs/design/ui.md § Debugging). Exits non-zero when something is over budget, so CI fails on a
# regression.
#
#   startup   cold start: first frame, the list read, the row build, the duplicate scan
#   refresh   the config changes while the window is up -- a background reload of the whole list
#   search    "lighthouse" typed one character at a time
#   switch    four chats opened in turn, the first of them the one with the long history
#
# A fifth job, `floor`, is an EMPTY window (dev/perf-floor.js). It always runs, because without it
# a main-loop block says as much about the renderer as about the app: with no GPU an empty window
# blocks for ~500 ms on its own. See dev/perf-report.mjs for what that does to the verdict.
#
# --small runs the CI size (1 200 chats / 12 000 messages, a few seconds); without it the full
# 10 500 / 100 000 that reproduces Pascal's freeze. Needs a built window bundle, or --build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The in-repo compositor wrapper, so CI can run this; HEADLESS_RUN takes over when it is set.
HEADLESS="${HEADLESS_RUN:-$ROOT/dev/headless.sh}"
BUILD=0 KEEP=0 BUDGET=50 CHATS=10500 MESSAGES=100000 ONLY=""
# How long each window stays up, and how far into the `refresh` one the config is touched. Long
# enough for every late idle batch to land and still be seen; `--small` is the CI size, where the
# whole run has to stay inside a couple of minutes.
LIFE=25 LONG_LIFE=45 POKE=20
WORK="${CURLEW_PERF_DIR:-/tmp/curlew-perf}"
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD=1 ;;
    --keep) KEEP=1 ;;
    --small) CHATS=1200 MESSAGES=12000 LIFE=12 LONG_LIFE=18 POKE=7 ;;
    --only) ONLY="${2:?}"; shift ;;
    --budget) BUDGET="${2:?}"; shift ;;
    --out) OUT="${2:?}"; shift ;;
    -h|--help) sed -n '3,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
OUT="${OUT:-$WORK/logs}"

cd "$ROOT"
[ "$BUILD" = 0 ] || gjsify workspace curlew-cli build >/dev/null
[ -f app/dist/window.gjs.mjs ] || { echo "no app/dist/window.gjs.mjs: run with --build" >&2; exit 1; }
[ -x "$HEADLESS" ] || { echo "no headless-run at $HEADLESS (set HEADLESS_RUN)" >&2; exit 1; }

D="$WORK/index"
rm -rf "$WORK"
mkdir -p "$D" "$OUT"
# The fixture is tens of megabytes; the disk on this workstation is tight, so it lives under /tmp
# and --keep is opt-in.
[ "$KEEP" = 1 ] || trap 'rm -rf "$WORK"' EXIT
ids="$(cd app && node --experimental-strip-types scripts/perf-index.ts "$D" "$CHATS" "$MESSAGES")"
long="$(printf '%s' "$ids" | sed -n 's/.*"longId":"\([^"]*\)".*/\1/p')"
short="$(printf '%s' "$ids" | sed -n 's/.*"shortId":"\([^"]*\)".*/\1/p')"
word="$(printf '%s' "$ids" | sed -n 's/.*"searchWord":"\([^"]*\)".*/\1/p')"
echo "perf: $CHATS chats, $MESSAGES messages in $D ($(du -sh "$D" | cut -f1))"

# Every scenario gets its own copy of the index: a run that marks a chat read or writes the config
# must not change what the next one measures.
data() {
  local w="$WORK/$1"
  if [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; then cp -a "$D" "$w"; fi
  printf 'CURLEW_DB_PATH=%s/index.db CURLEW_CONFIG=%s/config.json CURLEW_PREVIEWS_DIR=%s/previews CURLEW_AVATARS_DIR=%s/avatars CURLEW_DATA_DIR=%s CURLEW_SECRETS_DIR=%s/secrets' \
    "$w" "$w" "$w" "$w" "$w" "$w"
}
COMMON="CURLEW_NO_HOST_ACCOUNTS=1 CURLEW_DEBUG_STALL=1 CURLEW_DEBUG_STALL_MS=$BUDGET CURLEW_WINDOW_SIZE=900x640"

# <name> <seconds the window runs> <seconds until the config is touched, 0 = never> <cmd> <env>
JOBS="$WORK/jobs.tsv"
: >"$JOBS"
APP="gjsify run app/dist/window.gjs.mjs"
job() {
  [ -z "$ONLY" ] || [ "$ONLY" = "$1" ] || return 0
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" >>"$JOBS"
}
# The empty-window probe runs whatever --only says, because the report needs it to know what a
# main-loop block is worth in this environment (dev/perf-floor.js). Eight seconds.
printf '%s\t%s\t%s\t%s\t%s\n' floor 8 0 "gjs $ROOT/dev/perf-floor.js" "$COMMON" >>"$JOBS"
job startup "$LIFE" 0 "$APP" "$(data startup) $COMMON"
job refresh "$LONG_LIFE" "$POKE" "$APP" "$(data refresh) $COMMON"
job search "$LONG_LIFE" 0 "$APP" "$(data search) $COMMON CURLEW_WINDOW_TYPE=$word CURLEW_WINDOW_SCRIPT_MS=1500"
job switch "$LONG_LIFE" 0 "$APP" \
  "$(data switch) $COMMON CURLEW_WINDOW_SWITCH=$long,$short,$long,$short CURLEW_WINDOW_SCRIPT_MS=2500"
[ "$(wc -l <"$JOBS")" -gt 1 ] || { echo "no scenario matches --only $ONLY" >&2; exit 2; }

timeout 1200 "$HEADLESS" --size 1300x1000 -- "$ROOT/dev/perf-session.sh" "$JOBS" "$OUT" >/dev/null 2>&1 || true
node dev/perf-report.mjs "$OUT" "$BUDGET"
