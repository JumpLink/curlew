#!/usr/bin/env bash
# Test for changelog-section.sh. Run: scripts/changelog-section.test.sh
set -eu
dir="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/c.md" <<'MD'
# Changelog

## Unreleased

### Added

- unreleased thing

## 0.2.0

### Fixed

- two fix

## 0.1.0

- one thing
MD
fail=0
check() { # name expected actual
  if [ "$2" != "$3" ]; then echo "FAIL $1: expected [$2] got [$3]"; fail=1; else echo "ok   $1"; fi
}
check "tag with v" "$(printf '### Fixed\n\n- two fix')" "$("$dir/changelog-section.sh" v0.2.0 "$tmp/c.md")"
check "bare version" "- one thing" "$("$dir/changelog-section.sh" 0.1.0 "$tmp/c.md")"
check "prerelease falls back" "$(printf '### Fixed\n\n- two fix')" "$("$dir/changelog-section.sh" v0.2.0-rc.1 "$tmp/c.md")"
check "unknown falls back to Unreleased" "$(printf '### Added\n\n- unreleased thing')" "$("$dir/changelog-section.sh" v9.9.9 "$tmp/c.md")"
printf '# C\n\n## 1.0.0\n\n' > "$tmp/e.md"
if "$dir/changelog-section.sh" v1.0.0 "$tmp/e.md" 2>/dev/null; then echo "FAIL empty"; fail=1; else echo "ok   empty fails"; fi
exit "$fail"
