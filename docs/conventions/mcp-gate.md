# MCP tool gate

MCP tools are read-only or they do not register — unless a grant names them.

The server uses `applyGrantGate(server, grants)` (`server.ts`); `send_message` is registered BEFORE the gate (like `setup_run`), so it is always listed, and `sendAsAgent` is the decision: the exact `<backend>.send` for the `<account>/<address>`, or an address the backend itself recognises as the person's own (`SendBackend.isSelfAddress`, positive knowledge only, fail closed) which needs no grant. A backend never sends without a permit from a grant (`SendBackend.openSender`; XMPP's `GrantedXmppSession`, `XmppApi` stays read-only; Telegram's `TelegramSender`, `TelegramApi` stays read-only; Matrix's `MatrixSender` on its own `sendFetch`, the sync client's `readOnlyFetch` stays read-only).

The gate comes from **`@gjsify/mcp`**, since 0.54.0; it was `app/src/frontends/mcp/runtime.ts`, which no longer exists. It registers a tool only when `annotations.readOnlyHint === true`; a tool that omits the annotation is dropped. Do not loosen this to a name list.

## Canaries

Four canaries prove it still bites (`tools/gate-canary.ts`, `CURLEW_MCP_GATE_CANARY=1`, asserted by `test:mcp`, [ADR 0004](../adr/0004-sending-and-writing-granted-per-capability.md)):

1. a tool with `readOnlyHint: false`;
2. a tool with NO annotations;
3. a write tool whose capability is NOT granted, which must be absent;
4. a write tool whose capability IS granted (`canary.write`, accepted only under `CURLEW_MCP_GATE_CANARY=1`), which must be present.

The unannotated one is load-bearing — with only the first, the gate was rewritten to the fail-open spelling and the whole integration suite stayed GREEN. The granted one is the positive control: without it a gate that drops everything passes the other three. Never "simplify" them.

They matter MORE now, not less: the gate is upstream code, so these are the only thing that would catch an upstream flip — and the failure it guards against (a mutating tool served quietly) is invisible on the wire until it is exploited. `test:mcp` needs no change for this.
