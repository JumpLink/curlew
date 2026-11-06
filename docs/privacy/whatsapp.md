# WhatsApp privacy rules

WhatsApp is a **delivery-only** backend: it keeps no server archive. A message is gone from its servers once a device acknowledged it, so what `receiveDeliveries` writes is the only copy. With a `delivery-only` backend enabled the index is irreplaceable — never "fix" a problem by deleting and rebuilding it, and never ask the session for the next batch before the previous one is written.

## Auth state

The WhatsApp auth state (Signal keys) is `secret`. A linked device that does not connect for ~14 days is logged out by WhatsApp.

Baileys acknowledges a message BEFORE emitting it, so the receiver journals every event (fsync'ed, `secrets/whatsapp/<account>.journal`, 0600) before returning to Baileys, and replays a left-over journal first — never bypass it.

## Send is fenced by the receive lease

A WhatsApp send is fenced by the handle, and it takes the receive lease. There is no HTTP allowlist to draw the line on — it is one multiplexed WebSocket — so the receive handle (`WaSocketHandle`) simply has no send method and is not a supertype of `WaSendSocketHandle`; keep it that way.

The chat a sender may address is gated per permit in `packages/whatsapp/src/guard.ts`. WhatsApp allows ONE connection per linked device and Baileys' auth state is a single file with no lock, so `WHATSAPP_MANIFEST.sendSharesReceiveState` makes the app hold the receive lease around a send and refuse while the daemon has it — a refusal, never a second socket: a `connectionReplaced` (440) or a torn auth state ends in a relink, and the history is gone.

The send socket receives too, and journals what it gets like the receiver; unlike Signal it FLUSHES the auth state on close, because Baileys' own keys advanced on the wire.
