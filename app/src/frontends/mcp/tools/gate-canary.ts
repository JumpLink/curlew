/**
 * Tools that MUST NOT be served — the read-only gate's discriminator.
 *
 * The gate is the one safety-critical piece of this server, and until this file existed nothing
 * could tell a working gate from an absent one. Every real tool declares `readOnlyHint: true`, so
 * a gate that had silently stopped wrapping `registerTool` — an SDK rename, a registration path
 * that bypasses the wrapper, a bundler transform — would serve the exact same catalogue and
 * every assertion in the suite would stay green. That is a guard whose failure is invisible,
 * which is the same as no guard.
 *
 * The gate is `@gjsify/mcp`'s since 0.54.0 (it was this repo's, in `runtime.ts`, until then).
 * That raises the bar rather than lowering it: these canaries now have to catch a gate that
 * drifts UPSTREAM, which is why they stay.
 *
 * So this registers tools that must be dropped. Absent from `tools/list` = the gate closed.
 * Present = the gate is open and everything else the suite claims about read-only-ness is
 * worthless. Why there are two of them, and why the second is the one that matters, is on
 * `GATE_CANARY_TOOLS` below.
 *
 * Off unless `CURLEW_MCP_GATE_CANARY=1`, so it costs the shipped server nothing, and the
 * handlers are inert in any case: they perform no write, they only report having been
 * reachable. Enabling them can therefore never grant a capability — the worst case is two
 * tools that return an error string.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpError, mcpSuccess, requiresCapability } from '@gjsify/mcp';

import { CANARY_CAPABILITY } from '../../../core/grants.ts';

/**
 * TWO canaries, because one does not cover the failure that actually happens.
 *
 * Measured, not reasoned: with only the `readOnlyHint: false` canary in place, the gate was
 * rewritten to the fail-open spelling its own comment warns about —
 * `readOnlyHint === false ? undefined : register` — and the entire integration suite stayed
 * GREEN. Both spellings drop a tool that declares itself mutating, so that canary cannot tell
 * them apart. The difference between them is the UNANNOTATED tool: the correct gate drops it,
 * the fail-open one serves it. That is also the realistic defect, since an unannotated tool is
 * what a forgetful author produces, whereas nobody writes `readOnlyHint: false` by accident.
 *
 * So the second canary carries no `annotations` key at all, and it is the one with teeth.
 */
export const GATE_CANARY_TOOLS = [
  'gate_canary_write',
  'gate_canary_unannotated',
  'gate_canary_ungranted',
] as const;

/**
 * The positive control (ADR 0004 §3): declares the test-only capability `canary.write`, which the
 * integration test grants. It MUST be served there; without it a gate that drops everything would
 * pass the three canaries above. Its handler performs no write.
 */
export const GATE_CANARY_GRANTED = 'gate_canary_granted';

export function registerGateCanary(server: McpServer): void {
  if (process.env.CURLEW_MCP_GATE_CANARY !== '1') return;

  // Catches a gate that has stopped intercepting registration altogether.
  server.registerTool(
    'gate_canary_write',
    {
      title: 'Gate canary, declared mutating (must never be served)',
      description:
        'Test-only probe. Declares itself mutating so the read-only gate has something it MUST drop. If you can see this tool, the gate is not intercepting registration at all.',
      // The whole point: false, never true. Flipping this to true destroys the test.
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async () => mcpError('gate canary reached — the read-only gate is NOT closing'),
  );

  // Catches the gate pointed the wrong way. Deliberately carries NO annotations: a
  // default-deny gate drops it, a fail-open one serves it.
  server.registerTool(
    'gate_canary_unannotated',
    {
      title: 'Gate canary, unannotated (must never be served)',
      description:
        'Test-only probe with no readOnlyHint at all. A default-DENY gate drops it; a gate that only drops explicit writes serves it. If you can see this tool, the gate fails OPEN on every tool whose author forgot the annotation.',
    },
    async () => mcpError('gate canary reached — the read-only gate fails OPEN on unannotated tools'),
  );

  // A write tool whose capability is NOT granted: must be absent. `xmpp.send` is the real
  // capability, so this also holds when only the canary grant exists.
  server.registerTool(
    'gate_canary_ungranted',
    requiresCapability(
      {
        title: 'Gate canary, capability not granted (must never be served)',
        description:
          'Test-only probe that declares a capability no grant covers. The grant gate drops it; if you can see this tool, it serves writes nobody granted.',
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      { capability: 'canary.ungranted', targetOf: () => 'nowhere' },
    ),
    async () => mcpError('gate canary reached — the grant gate serves an ungranted capability'),
  );

  // The positive control: granted through `canary.write`, so it MUST be served.
  server.registerTool(
    GATE_CANARY_GRANTED,
    requiresCapability(
      {
        title: 'Gate canary, capability granted (must be served)',
        description:
          'Test-only positive control. Served only when a canary.write grant exists; proves the gate opens for a grant. Performs no write.',
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      { capability: CANARY_CAPABILITY, targetOf: () => 'canary' },
    ),
    async () => mcpSuccess({ reached: true }),
  );
}
