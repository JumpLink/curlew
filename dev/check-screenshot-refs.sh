#!/usr/bin/env bash
#
# dev/check-screenshot-refs.sh -- every docs/screenshots/*.png that the README, the docs or the
# AppStream metainfo points to must exist. Exit 1 and list the missing files otherwise.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

rc=0
while IFS= read -r ref; do
  file="docs/screenshots/${ref##*/}"
  [ -s "$file" ] || { echo "missing: $file (referenced as $ref)" >&2; rc=1; }
done < <(
  grep -rhoE 'screenshots/[A-Za-z0-9._-]+\.png' README.md docs/guide docs/design docs/concepts app/data/*.metainfo.xml 2>/dev/null |
    sort -u
)
exit "$rc"
