#!/usr/bin/env bash
# Print the body of one version's section of CHANGELOG.md (without its heading).
# Usage: scripts/changelog-section.sh <tag-or-version> [changelog]
# `v0.2.0` and `0.2.0` both select `## 0.2.0`. A prerelease tag (`v0.2.0-rc.1`) falls back to
# the base version's section, then to `## Unreleased`. Exits 1 when nothing is found or empty.
set -eu
version="${1:?usage: changelog-section.sh <tag-or-version> [changelog]}"
file="${2:-CHANGELOG.md}"
version="${version#v}"

extract() {
  awk -v want="$1" '
    /^## / { if (on) exit; h = substr($0, 4); sub(/[ \t]+$/, "", h); on = (h == want); next }
    on { print }
  ' "$file"
}

for want in "$version" "${version%%-*}" "Unreleased"; do
  body="$(extract "$want")"
  # Trim leading and trailing blank lines.
  body="$(printf '%s\n' "$body" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}')"
  if [ -n "$body" ]; then
    printf '%s\n' "$body"
    exit 0
  fi
done
echo "no CHANGELOG section for $version" >&2
exit 1
