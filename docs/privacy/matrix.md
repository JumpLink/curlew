# Matrix privacy rules

Matrix is read-only through a gate, not through good intentions. Every request of matrix-js-sdk goes through `readOnlyFetch` (`packages/matrix/src/guard.ts`): GETs, login, the sync filter and the E2EE key protocol pass; a `/sync` without `set_presence=offline` (an omitted value means ONLINE) and everything else — receipts, typing, sends, joins — is refused and fails the sync. Widen the allowlist only with a test naming the request.

## A granted send does not widen the sync gate

A granted `matrix.send` does not widen `readOnlyFetch`. `MatrixBackend.openSender` wraps a second, separate `fetch` (`sendFetch`, same file) around the permit's rooms, and it passes exactly one request: `PUT …/rooms/{roomId}/send/m.room.message/{txnId}` for a room the permit names. The allowlist spells `m.room.message` literally, so an `m.room.encrypted` PUT is refused there too.

`sendFetch` keeps its refusals out of the global `refusals` ledger on purpose — a refused send must not fail a sync that is running beside it.

## No cleartext into encrypted rooms

Curlew never sends cleartext into an encrypted room. Before every send the sender asks `GET …/rooms/{roomId}/state/m.room.encryption`: `M_NOT_FOUND` means unencrypted and the send goes ahead, a `200` means the room is encrypted and the send is **refused**. Any other answer throws — an unanswerable state read is never read as "unencrypted". There is no Megolm sending path here, and a cleartext `m.room.message` in a Megolm room would both be unreadable to the room and defeat the encryption its members chose. Do not "fall back" to sending.

## Crypto state before acknowledgement

The SDK's store checkpoints the crypto snapshot in `setSyncData`, which the sync loop awaits before the next `/sync` — the request that tells the server the to-device keys arrived. A save failure stops the run and is reported; it is never swallowed.
