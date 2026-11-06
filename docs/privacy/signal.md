# Signal privacy rules

Signal is read-only through a gate too. The only way to send a request is a libsignal chat connection's `fetch`, and it is handed out only behind `guardedFetch` (`packages/signal/src/guard.ts`): at link time `PUT /v1/devices/link` and `PUT /v2/keys?identity=aci`, during a sync nothing — the sync's `ChatHandle` has no `fetch` at all. Widen the allowlist only with a test naming the request. The one thing a sync sends is the envelope acknowledgement.

## Acknowledge only what is on disk

Per commit: decrypt → journal (fsync, `secrets/signal/<account>.journal`) → protocol store flush → acknowledge. Never acknowledge first (Signal deletes acknowledged envelopes), and never flush the protocol store on `close` (`store.discard()`): a saved ratchet step for an unacknowledged envelope turns its redelivery into a "duplicate" and loses the message.

libsignal is never imported at module level — it is loaded on first use (`lib.ts`) so curlew starts where the addon does not.

## Set-aside ledger

A plaintext that decrypts but that this build cannot map (a field a newer Signal added, a parser bug) joins that same flush in the account file's `signal.setaside` ledger — received, not lost, and counted in `DeliveryOutcome.setAside`; the ledger is bounded (`SET_ASIDE_LIMIT`) and a run that pushes an entry out says so.

## Identity-key changes

An accepted identity-key change is never silent: it becomes a `presentation: 'notice'` message in that contact's direct chat.
