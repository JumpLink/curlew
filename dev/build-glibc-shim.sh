#!/usr/bin/env bash
# Build the glibc shim Signal needs on musl (see contrib/glibc-shim/shim.c).
#
#   dev/build-glibc-shim.sh    host build, plus aarch64-musl when `zig` is installed
#
# Output: dist/glibc-shim/<target>/libcurlew-glibc-shim.so. Dev only — CI and the Flatpak
# do not run this. On a musl device, build with `cc -shared -fPIC shim.c /lib/libgcompat.so.0`.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC='contrib/glibc-shim/shim.c'
OUT='dist/glibc-shim'
NAME='libcurlew-glibc-shim.so'

mkdir -p "$OUT/host"
cc -shared -fPIC -O2 -o "$OUT/host/$NAME" "$SRC"
echo "built $OUT/host/$NAME"

if command -v zig >/dev/null 2>&1; then
    mkdir -p "$OUT/aarch64-musl"
    zig cc -target aarch64-linux-musl -shared -fPIC -O2 -o "$OUT/aarch64-musl/$NAME" "$SRC"
    echo "built $OUT/aarch64-musl/$NAME"
else
    echo "zig not found: skipping the aarch64-musl build"
fi
