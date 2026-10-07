# @curlew/smtp

Send one message, with attachments, over SMTP. A thin, checked layer on
[nodemailer](https://nodemailer.com) (pinned exactly): no `gi://`, runs on GJS and on Node.

**This is a library capability, not a tool.** curlew's index and its MCP server stay read-only
and fail-closed; nothing in `app/src/frontends/mcp` sends mail, and nothing here registers one.
The caller sends, and only with the human's explicit consent for that message.

## API

```ts
import { buildMessage, sendMessage, verifyAccount, SmtpError } from '@curlew/smtp';

const account: SmtpAccount = {
  host: 'smtp.example.invalid',
  port: 587,
  security: 'starttls', // 'tls' | 'starttls' | 'none' (127.0.0.1 and localhost only)
  username: 'user@example.invalid',
  auth: { kind: 'password', password } /* or { kind: 'oauth2', accessToken } */,
  tls: { ca: pem }, // optional: trust a private CA; rejectUnauthorized: false switches checking off
};

await verifyAccount(account); // connects and logs in; sends no MAIL FROM
const raw = await buildMessage(message); // RFC 5322 bytes, no network
const sent = await sendMessage(account, message); // { messageId, accepted, rejected, response }
```

`OutgoingMessage` is `{ from, to[], cc?[], subject, text, html?, attachments?, messageId? }`;
an attachment is `{ filename, content: Uint8Array, contentType? }`. Without a `messageId` one is
generated on the domain of `from`.

- Addresses are plain `local@host`. No display names, no groups, no further validation.
- A line break or other control character in the subject, an address, a filename, a content
  type or the Message-ID is refused, not stripped (header injection).
- `sendMessage` returns the recipients the server refused while taking others in `rejected`;
  when it takes none it throws. `MAIL FROM` is sent by `sendMessage` only.
- Attachments are bytes. File and URL access are off, so a message can never name a path.

## Errors

Every failure is an `SmtpError` with a `code`: `auth`, `tls`, `connect`, `rejected` or `config`
(nothing was sent), and the numeric `responseCode` of a server refusal. The message is fixed text
plus the server's reply with the account's secrets cut out, and the library error is not kept.
`detail` adds its code and text (`ESOCKET: connect ECONNREFUSED …`, `ESOCKET: self-signed certificate`),
scrubbed and cut to 200 characters, so a dialog can say what to fix.

## What it does not do

- No MCP tool, no CLI command: sending is not exposed to an agent.
- No secret in a log, an error text or a result. Credentials are parameters of the call; the
  package reads no file, no environment, no store, and turns the library's loggers off.
- No `security: 'none'` beyond the loopback, because that sends the password in the clear.

## Tests

`app/tests/unit/smtp/`, on GJS and Node: message building and validation, errors without
secrets, and a plaintext dummy server on 127.0.0.1 (no TLS) that records what the client sent:
`AUTH PLAIN` / `XOAUTH2` arrived, the attachments are the MIME parts, `verifyAccount` sent no
`MAIL FROM`.

TLS is tested too: the dummy server speaks implicit TLS and STARTTLS with a self-signed certificate
generated per run with `openssl` (never committed). Covered: `security: 'tls'` with `tls.ca`, the
STARTTLS upgrade, a refused upgrade, and a certificate the `tls.ca` does not cover (`tls`, not
`connect`). The server side of the STARTTLS upgrade needs `node:tls` to wrap an accepted socket,
which gjsify does for clients only, so that one case runs on Node only; the client upgrade is the
part an app uses.
