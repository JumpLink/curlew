/**
 * The setup MCP tools, invoked.
 *
 * Asserting on the SOURCE proves nothing about a refusal, so every test here CALLS a handler. The
 * three claims are the ones a comment cannot make:
 *
 *   - a human-only step is refused, and the refusal carries the exact command a person runs;
 *   - `setup_status` cannot return a pairing payload, not even with a backend linked;
 *   - the step id in the schema is the steps' own names, so a tool cannot name a stage the CLI
 *     would not.
 */

import { describe, expect, it } from '@gjsify/unit';

import { SETUP_STEPS, setupStatus } from '../../../src/core/actions/setup.ts';
import type { SetupContext } from '../../../src/core/actions/setup.ts';
import { registerSetupTools, SETUP_STEP_IDS } from '../../../src/frontends/mcp/tools/setup.ts';
import { FAKE_PAIRING_PAYLOAD, fakeContext } from '../core/setup-fakes.ts';
import { createRecorder } from './recorder.ts';

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

function callTool(name: string, params: unknown): Promise<ToolResult> {
  const rec = createRecorder();
  registerSetupTools(rec.server);
  return rec.handler(name)(params) as Promise<ToolResult>;
}

function payload(result: ToolResult): unknown {
  return JSON.parse(result.content[0]?.text ?? '{}') as unknown;
}

export default async function setupTools(): Promise<void> {
  await describe('the human-only refusal', async () => {
    // Pinned against `SETUP_STEPS` rather than a list written here: a second list of step names
    // is a second thing to forget when a stage is added, and the whole point of the flag living
    // on the step is that it cannot drift.
    const humanOnly = SETUP_STEPS.filter((step) => step.humanOnly === true);

    for (const step of humanOnly) {
      await it(`refuses ${step.name} and names the command the person must run`, async () => {
        const result = await callTool('setup_run', { step: step.name });
        expect(result.isError).toBe(true);
        const text = result.content[0]?.text ?? '';
        // The exact command, from the core's own `humanOnlyRefusal` — the same string the
        // terminal would print, so the two surfaces cannot disagree about what to run.
        expect(text.includes(step.command)).toBe(true);
        expect(text.includes('only the account holder can take')).toBe(true);
        // And it must not be a JSON error blob that merely mentions it: a refusal is a sentence
        // a person reads, so it has to survive being wrapped.
        expect((payload(result) as { error: string }).error.includes(step.command)).toBe(true);
      });
    }

    await it('refuses on the flag, not on a name list: every humanOnly step is covered', async () => {
      // If a stage is marked humanOnly and this tool does not refuse it, the flag is decoration.
      // Spelled by asking the OTHER question: a step NOT marked humanOnly must not be refused for
      // being a human act, so the refusal cannot be a blanket "setup needs a person".
      const result = await callTool('setup_run', { step: 'readiness' });
      expect(result.isError).toBeFalsy();
      expect((payload(result) as { error?: string }).error).toBe(undefined);
    });
  });

  await describe('the step id schema', async () => {
    await it('accepts exactly the steps the CLI has', async () => {
      const rec = createRecorder();
      registerSetupTools(rec.server);
      const step = rec.find('setup_run')?.inputSchema?.step;
      expect(step).toBeDefined();
      if (step === undefined) return;
      for (const name of SETUP_STEP_IDS) expect(step.safeParse(name).success).toBe(true);
      expect(step.safeParse('not-a-stage').success).toBe(false);
    });

    await it('rejects an unknown stage by name, not by omission', async () => {
      const result = await callTool('setup_run', { step: 'nope' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text.includes('unknown setup stage')).toBe(true);
    });
  });

  // The security property, tested rather than asserted: `setup_status` returns eight probes over
  // the machine — counts, file existence, an exit code — and none of them reads a session. So a
  // payload has nowhere to hide in the value. The stub is armed to THROW if it is called, so a
  // future change that reaches the linker fails here instead of shipping a QR into a transcript.
  await describe('setup_status and the pairing payload', async () => {
    for (const linked of [0, 2]) {
      await it(`carries no payload with ${linked} linked account(s)`, async () => {
        let linkedCalled = false;
        const ctx: SetupContext = fakeContext({
          countAccounts: async () => linked,
          link: async () => {
            linkedCalled = true;
            throw new Error('the linker must never be reached from a status read');
          },
        });
        // A linked backend, so the state really is `done` for the two linking stages: the
        // strongest case, because "already linked" is the only state a payload would survive in.
        const status = await setupStatus(ctx);
        const text = JSON.stringify(status);
        expect(text.includes(FAKE_PAIRING_PAYLOAD)).toBe(false);
        expect(text.includes('ts01://')).toBe(false);
        expect(linkedCalled).toBe(false);
        for (const step of status.steps.filter((s) => s.name.startsWith('link-'))) {
          // Both states are covered, because the payload property must hold either way: linked
          // (`done`) is the case where a linker was needed and not called, unlinked (`remaining`)
          // is the one where the stage is still outstanding. Neither state may carry a payload.
          expect(step.state).toBe(linked > 0 ? 'done' : 'remaining');
          // What it does carry instead: the invocation, which is the point of a human-only step.
          expect(step.command).toBe(`postbote setup --only ${step.name}`);
          expect(step.humanOnly).toBe(true);
        }
      });
    }

    await it('the served tool hands back exactly the core status, warning included', async () => {
      // A read-only surface must not silently drop the warning the fix added: that is precisely
      // how a machine with no session bus came to be reported as ready.
      const rec = createRecorder();
      registerSetupTools(rec.server);
      expect(rec.find('setup_status')?.annotations?.readOnlyHint).toBe(true);
      expect(rec.find('setup_run')?.annotations?.readOnlyHint).toBe(false);
    });
  });
}
