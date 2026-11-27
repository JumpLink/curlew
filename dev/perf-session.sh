#!/usr/bin/env bash
#
# dev/perf-session.sh <jobs-file> <out-dir> -- runs INSIDE one `headless-run` session (see
# dev/perf.sh) and plays every responsiveness scenario on it, one window per scenario.
#
# Job line, tab separated: <name> <seconds> <poke-seconds> <command> <env words...>. The command
# runs with the stall probe on; its `[stall] …` lines land in <out-dir>/<name>.log, which
# dev/perf-report.mjs reads. A non-zero <poke-seconds> touches the config file that many seconds
# in: that changes the list stamp, which is what makes the window reload in the background.
# The command is a field of its own because one job is not the app at all: dev/perf-floor.js
# measures an empty window, and it has to be measured in THIS session to be comparable.
set -uo pipefail

JOBS="${1:?jobs file}"
OUT="${2:?output directory}"
cd "$(dirname "$0")/.."
mkdir -p "$OUT"

A=""
P=""
kill_app() { [ -z "$A" ] || { kill -- -"$A" 2>/dev/null; wait "$A" 2>/dev/null; A=""; }; }
kill_poke() { [ -z "$P" ] || { kill "$P" 2>/dev/null; wait "$P" 2>/dev/null; P=""; }; }
trap 'kill_app; kill_poke' EXIT

while IFS=$'\t' read -r name seconds poke cmd envs; do
  [ -n "$name" ] || continue
  # shellcheck disable=SC2086
  setsid env $envs $cmd >"$OUT/$name.log" 2>&1 & A=$!
  if [ "${poke:-0}" -gt 0 ]; then
    # shellcheck disable=SC2086
    config="$(printf '%s\n' $envs | sed -n 's/^CURLEW_CONFIG=//p' | head -1)"
    [ -z "$config" ] || { (sleep "$poke"; touch "$config") & P=$!; }
  fi
  for _ in $(seq "$(( seconds * 10 ))"); do
    kill -0 "$A" 2>/dev/null || break
    sleep 0.1
  done
  kill_app
  kill_poke
  sleep 0.3
done <"$JOBS"
exit 0
