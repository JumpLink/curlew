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
| expired.badssl.com:443 | handshake rejected ("Unacceptable TLS certificate") | 1234 ms |
| self-signed.badssl.com:443 | handshake rejected | 1250 ms |

Times include DNS and the first handshake in a cold process; one run each, emulator network.
The TLS add-on loaded `libgioopenssl.so` and trusted 149 system CAs (75 ms).

## APK size

Debug build, both ABIs in one APK: 113 MB. Native libraries by ABI (uncompressed `lib/<abi>/`):
arm64-v8a 50.2 MB, x86_64 53.1 MB. ABIs are restricted to those two in `data/Android/gradle.properties`.

## Gaps found

- `node:fs` is not bridged beyond `fs/promises`; `@curlew/protocol`'s `media-probe.ts` needs
  `openSync`/`readSync`. The shell stubs that module (`vite.config.ts`, `app/media-probe-stub.ts`).
- The nativescript vite preset maps `gi://Gio`/`gi://GLib` to the widget renderer's sparse arm (no
  `SocketClient`) or to an empty module, with no switch for real Gio. The shell resolves both to
  `@gjsify/node-gi` itself (`vite.config.ts` plugin `curlew-real-gi`).
- Fixed at the Curlew boundary: `@curlew/imap/stream` is a narrow entry without `@curlew/store` and
  `@gjsify/system-accounts`; `ImapClient.capability()` is public.

## Still open

Login, the store (AP5.1) and the window layer (AP5.3) are unproven on Android.
