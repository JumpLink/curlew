# AP5.2 probe: IMAP over Gio TLS on Android

Measured 2026-11-20 on the `NsGi_API_36` emulator (x86_64, debug build) with the
[`app-android/`](../../app-android) shell. On start it runs `openTlsStream` and `ImapClient` from
`@curlew/imap/stream` against public servers (no credentials) and logs lines prefixed
`CURLEW-PROBE` to logcat and to a label list in the window.

## Result

| Probe | Result | Time |
|---|---|---|
| imap.gmail.com:993, greeting + CAPABILITY + LOGOUT | pass (15 tokens) | greeting 1571 ms, total 1617 ms |
| imap.fastmail.com:993, greeting + CAPABILITY + LOGOUT | pass (20 tokens) | greeting 1757 ms, total 2063 ms |
| expired.badssl.com:443 | handshake rejected ("Unacceptable TLS certificate"); under `giReal` it fails with "Connection reset by peer" instead of the certificate error | 1234 ms |
| self-signed.badssl.com:443 | handshake rejected | 1250 ms |

Times include DNS and the first handshake in a cold process; one run each, emulator network.
The TLS add-on loaded `libgioopenssl.so` and trusted 149 system CAs (75 ms).

## APK size

Debug build, both ABIs in one APK: 113 MB. Native libraries by ABI (uncompressed `lib/<abi>/`):
arm64-v8a 50.2 MB, x86_64 53.1 MB. ABIs are restricted to those two in `data/Android/gradle.properties`.

## Gaps found

- `node:fs` was not bridged beyond `fs/promises`; `@curlew/protocol`'s `media-probe.ts` needs
  `openSync`/`readSync`. Fixed in gjsify 0.64.53 (`@gjsify/native-fs-bridge`); `fstatSync` (used by `media-probe.ts`) follows in 0.64.54; the shell's stub is gone.
- The nativescript vite preset had no switch for real Gio beside the widget renderer. Fixed in
  gjsify 0.64.53: the shell sets `giReal: ["Gio", "GLib"]` in `vite.config.ts`.
- Fixed at the Curlew boundary: `@curlew/imap/stream` is a narrow entry without `@curlew/store` and
  `@gjsify/system-accounts`; `ImapClient.capability()` is public.

## Still open

Login, the store (AP5.1) and the window layer (AP5.3) are unproven on Android.
