#!/usr/bin/env bash
# Android SMTP probe: build and install the app-android debug APK on a running emulator, then let
# the host harness serve loopback dummy SMTP servers and judge what arrived (never a real account).
#   NS_SKIP_ENV_CHECK=1 dev/android-smtp-probe.sh      (ANDROID_SERIAL=emulator-5554)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
apk="$(find "$root/app-android/platforms/android" -name '*-debug.apk' | head -n1)"
[ -n "$apk" ] || { echo "no debug APK: run 'ns build android' in app-android first" >&2; exit 1; }
adb install -r "$apk"
adb logcat -c
adb logcat -s 'CURLEW-PROBE:*' 'JS:*' 'AndroidRuntime:E' > /tmp/curlew-smtp-probe-logcat.log &
logcat=$!
trap 'kill $logcat 2>/dev/null || true' EXIT
node "$root/dev/android-smtp-probe-host.ts"
