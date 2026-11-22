# ADR 0018: the mail transport is a byte-stream port

- **Status:** Proposed (2026-11-19). The first increment (the port, the pure client, the send
  entry) is in the same change as this text. No device run yet.
- **Scope:** `@curlew/protocol` (`ByteStream`, `MailStreamOpener`, `ByteReader`), `@curlew/imap`
  (client, transport, entries), `app` (backend registry). Step AP5.2 of the Android port
  ([p5-measurement.md](../android/p5-measurement.md)).
- **Builds on:** gjsify ADR 0110 (real GObject is the Android default), ADR 0117 (Android GI
  namespaces are selected at build time, § 3 and stage 2) and ADR 0134 (HTTPS trusts the OS store
  through `@gjsify/tls-trust`).

## Context

`@curlew/imap` spoke to `Gio.SocketClient` directly. `client.gjs.ts` held a `Gio.IOStream`, and the
reader took a `Gio.InputStream`. Two things followed from that.

The client could not run without Gio, so no test covered its command sequencing. The parsing was
tested in `@curlew/protocol`, the socket code was not.

The entry also exported `MailSender`, which imports `@curlew/smtp` and with it nodemailer. Every
consumer of the IMAP entry therefore needed `node:net` and `node:tls`. Both are `none` for
NativeScript in gjsify, so a read-only Android build could not even be bundled.

### Does Gio have TLS on Android today? No.

Measured on 2026-11-19 against the sysroot that gjsify pins (`gjsify/android-sysroot` tag
`2026.11.03`, the tarballs whose sha256 `build-inputs.json` names, both ABIs):

- `lib/<abi>/gio/modules/` is an empty directory. 1329 entries per tarball, none matches
  `gioopenssl`, `giognutls`, `libssl`, `libcrypto`, `libgnutls` or `glib-networking`.
- `payload-baseline.json` in `@gjsify/gi-runtime-android` lists the libraries an APK gets. It has
  `libgio-2.0.so` and no TLS library.
- `libgio-2.0.so` itself exports the `GTlsBackend` API with the dummy backend. `set_tls(true)`
  therefore compiles and loads, and the handshake fails with "TLS support is not available".

This is a reading of the shipped artifact, not a device run. A device run cannot give a different
answer, because the module file does not exist in anything the build can package.

gjsify has already decided how this changes. ADR 0117 stage 2 adds glib-networking and its TLS
library to the sysroot as the add-on `@gjsify/gi-runtime-android-tls`. The owner chose OpenSSL
(2026-11-03), and ADR 0134 installs the Android system CA directory as Gio's default database.
None of that is built yet, and a sysroot release needs the owner's explicit OK.

## Decision

### 1. The IMAP client talks to a port, never to a socket

`@curlew/protocol` declares the port:

```ts
interface ByteStream {
  read(max: number): Promise<Uint8Array>; // short reads are normal, empty means end of stream
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>; // safe to call twice
}
type MailStreamOpener = (target: MailTarget) => Promise<ByteStream>;
```

Three methods, pull-based, no events. That is what IMAP needs (the client always knows whether it
waits for a line or for n bytes) and it is the smallest thing every platform can supply. It is
deliberately not `node:net`. A Duplex stream brings buffering, events and half-open states that the
client would have to undo again.

A stream from an opener is already encrypted and verified. Certificate checks, the trust store and
SNI belong to the implementation. The client has no "insecure" switch to pass down.

`ByteReader` moves to `@curlew/protocol` next to the port. `ImapClient` takes the opener in its
constructor and has no `gi://` import, so it is `client.ts` now and runs on Node.

### 2. One implementation per TLS stack, chosen by the entry

| Platform | Opener | State |
|---|---|---|
| GJS desktop | `openTlsStream` on `Gio.SocketClient` (`transport.gjs.ts`) | unchanged behaviour |
| Android | the same Gio opener, once the TLS add-on ships | blocked on gjsify ADR 0117 stage 2 |
| iOS | an opener on `Network.framework` | later, after Android |

**Android uses Gio, and Curlew does not write a `javax.net.ssl` socket to bridge the gap.** The
reasons:

- gjsify needs glib-networking on Android anyway. `@gjsify/fetch` (libsoup), `tls`, `http2` and
  `ws` all wait for the same module. A Java socket in Curlew would fix one consumer and leave the
  autoconfig lookup (`fetch`) and every chat backend where they are.
- ADR 0134 already settles which CAs are trusted. A second TLS stack inside one app means a second
  trust decision, and the two would differ on user-installed CAs.
- "Fix at the core" applies. The missing piece is a sysroot build, and that is where the work goes.

If stage 2 slips, the fallback is a `ByteStream` over `javax.net.ssl.SSLSocket`, and it belongs in
gjsify as a `nativescript-bridge` package, not in this repo. The port makes that a new opener and
nothing else. iOS needs exactly this shape regardless, because real GI is unproven there.

### 3. Sending is its own entry

`@curlew/imap` no longer exports `MailSender` or `openMailSender`, and `ImapBackend` no longer
implements `SendBackend`. The new entry `@curlew/imap/send` exports `ImapSendBackend` (the backend
plus `openSender`) and the sender. The desktop registry registers `ImapSendBackend`, so the app
behaves as before. A read-only build registers `ImapBackend` and never has `@curlew/smtp` or
nodemailer in its import graph.

`isOwnMailAddress` and the backend's `isSelfAddress` move to `own-address.ts`. They read the SMTP
target for the account's address and need no SMTP code.

No compatibility re-export stays behind. The three tests that imported `MailSender` from the main
entry import it from `@curlew/imap/send`.

### 4. Tests

- `protocol/byte-stream.test.ts`: the reader over short reads, literals, a short transfer, a skip.
- `mail/imap-client.test.ts`: the client against a scripted stream. Greeting, EXAMINE, the APPEND
  continuation, a streamed part, a refused oversized part that leaves the connection in step, a
  connection that ends mid-command, logout against a dead peer. Both runtimes.
- `mail/entry-graph.test.ts`: walks the relative imports of each entry. The main entries must not
  reach `send.ts` or `@curlew/smtp`, and `transport.gjs.ts` must be the only file of the main entry
  with a `gi://` import. This is the test that fails when someone adds a convenient re-export.

## Consequences

- The command sequencing of the IMAP client is tested for the first time.
- `@curlew/imap` has no Node stub (follow-up, 2026-11-20). `ImapBackend` and the mail functions
  take the opener from the caller; `backend.ts` and `messages.ts` lost the `.gjs` suffix; the
  entries differ only in the exported `openTlsStream` (Gio, or `node:tls` in `transport.node.ts`,
  implicit TLS only). `app` injects it, tests inject a scripted stream.
- SMTP on Android stays out of reach until gjsify has `node:net` and `node:tls` for NativeScript,
  or until `@curlew/smtp` gets a transport on the same port. v1 is read-only, so this is not on
  the path.
- Curlew on Android cannot open a mailbox until the TLS add-on exists. That dependency was already
  there. It is now written down with the measurement.

## What remains for AP5.2

1. gjsify ADR 0117 stage 2: glib-networking and OpenSSL in the sysroot, the
   `@gjsify/gi-runtime-android-tls` add-on, `@gjsify/tls-trust` on Android. Needs the owner's OK
   for the sysroot release.
2. ~~Inject the opener into `ImapBackend` and the `messages` functions~~ Done 2026-11-20.
3. A device run on the `NsGi_API_36` emulator: `openTlsStream` against a loopback TLS server with
   a test CA, then against a public IMAP greeting. Record handshake time and APK size per ABI.
4. STARTTLS stays rejected. Not part of this step.

## Amendment (2026-11-23): SMTP rides the same port

nodemailer's SMTP transport needs `node:net` and `node:tls`, which are `none` for NativeScript.
Only the wire protocol has to be ours; MIME composition stays with nodemailer's `MailComposer`,
which yields the RFC 5322 bytes.

- **`@curlew/smtp/wire`** speaks SMTP over a `ByteStream`: EHLO with HELO fallback, capability
  parsing, STARTTLS then EHLO again, AUTH PLAIN, LOGIN and XOAUTH2, the envelope with partial
  recipient refusals, DATA with dot-stuffing and CRLF normalisation, timeouts, QUIT. Errors map to
  the existing `SmtpError` codes. Nothing is logged and server text is scrubbed of the account's
  secrets. The entry imports no nodemailer.
- **STARTTLS needs a TLS upgrade on an open stream**, so the port grows (IMAP is unchanged):

  ```ts
  interface UpgradableByteStream extends ByteStream {
    upgradeTls(): Promise<void>; // handshake in place, verified against the opened host
  }
  type MailEndpointOpener = (e: { host; port; tls: 'implicit' | 'none'; ca? }) => Promise<UpgradableByteStream>;
  ```

  `upgradeTls` rejects when plaintext is still unread (STARTTLS injection), when the stream is
  already encrypted, or when the handshake fails; the stream is dead then. `ca` is a trust anchor
  for stacks that take one; the Gio opener rejects it rather than ignore it.
- Implemented in `transport.node.ts` (`tls.connect({ socket })`) and `transport.gjs.ts`
  (`Gio.TlsClientConnection.new` + `handshake_async`). The Gio path is not run on a device yet.
- `sendMessage` and `verifyAccount` take an optional `WireTransport`. Without it the nodemailer
  path runs as before, so desktop behaviour is unchanged. Android wiring waits for the gjsify fix
  that lets the composer be bundled.

## Alternatives considered

- **A `node:net`/`node:tls` slot for NativeScript in gjsify, and the client on top of it.** Larger
  than the problem: the full Socket and TLSSocket API for a client that reads lines. It is still
  the right fix for nodemailer and belongs to the SMTP step.
- **A Java TLS socket now, Gio later.** Two transports to test on one platform, and the first one
  would be deleted. Kept as the named fallback in § 2.
- **Leave the client on Gio and only split the entry.** Solves the bundling and leaves iOS with a
  rewrite of the client.
