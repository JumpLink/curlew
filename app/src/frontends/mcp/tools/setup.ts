/**
 * The setup surface for an agent: `setup_status` and `setup_run`.
 *
 * Two tools, and the split is the security property rather than a convenience.
 * `applyReadOnlyGate` registers a tool only when it declares `readOnlyHint: true`, so
 * `setup_status` is served on every connection and `setup_run` is not served at all unless
 * `CURLEW_MCP_ALLOW_WRITE=1`. There is no name list anywhere in this file and none is wanted:
 * the annotation is what the gate reads, and a second list is a second thing to forget to update.
 *
 * ONE mutating tool, not eight. Eight tools would mean eight more entries for the gate to judge
 * and eight more chances to register one of them wrongly; one tool with a `step` id keeps the
 * gate's surface a single entry while the id keeps the action explicit — a caller says
 * `setup_run unit`, never "do the setup".
 *
 * THE RULE THIS FILE EXISTS TO ENFORVE: a human-only step is refused here, on every call, and
 * the refusal is `humanOnlyRefusal(step)` — the core's own message, quoting the core's own
 * `curlew setup --only <name>`. Not a second refusal written here, and not a list of step names:
 * the flag lives on the step (`SetupStep.humanOnly`), so a step the CLI treats as a human act is
 * a step this tool refuses, and the two cannot drift. A person typing `--only terms` in their own
 * terminal is that person, which is exactly what the flag is for.
 *
 * WHY the refusal is not ceremony. The provisioning payload — the QR and its pairing code — is
 * the secret that binds an account to a machine. An agent holding it can act as the account
 * holder, and the payload is rendered by the backend into a tool result, a log and a journal the
 * moment it goes anywhere but a screen. So:
 *
 *   - `setup_run` never reaches `step.run` for such a step, which is the only thing that can
 *     produce a payload;
 *   - `ctx.link` here THROWS rather than linking. Belt and braces: the refusal already makes the
 *     call unreachable, so a step that reached it would be a bug, and a bug that throws is one
 *     this surface cannot have quietly.
 *
 * And `setup_status` is structurally incapable of returning one: it returns `setupStatus(ctx)`,
 * which is eight probes over the machine — a count, a file's existence, a `systemctl` exit code —
 * plus the readiness facts. No probe reads a session, so there is nothing in the value for a
 * payload to hide in. `app/tests/unit/mcp/setup-tools.test.ts` pins that against a stub that
 * throws if it is called.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpError, mcpSuccess } from '@gjsify/mcp';
import { envValue } from '@curlew/store';
import { z } from 'zod';

import type { SetupContext, SetupPrompter, SetupStep } from '../../../core/actions/setup.ts';
import { SETUP_STEPS, humanOnlyRefusal, runSetup, setupStatus } from '../../../core/actions/setup.ts';
import { detectSetup } from '../../../core/actions/setup.ts';
import { nodeHost, setupConfigPath, setupIndexPath } from '../../../core/actions/setup-host.ts';
import { mcpErrorFrom } from '../types.ts';

export const SETUP_TOOL_NAMES = ['setup_status', 'setup_run'] as const;

/** The step ids, taken from the steps themselves — the schema cannot name one the CLI would not. */
export const SETUP_STEP_IDS = SETUP_STEPS.map((step) => step.name);

const STEP_IDS = SETUP_STEP_IDS as [string, ...string[]];

/**
 * A prompter for a surface with no person behind it.
 *
 * `confirm` is NO, always, and that is the whole point rather than a limitation: an unanswered
 * question must never enable a backend, accept a term or install a unit on somebody's behalf —
 * the same rule the terminal prompter applies at EOF. `notify` is COLLECTED rather than dropped,
 * so a caller gets the stage's own words back as a transcript instead of only an outcome, and
 * `ask` refuses outright: a question needing a typed answer has no one here to answer it, and an
 * invented answer would be a decision nobody made.
 */
function agentPrompter(): SetupPrompter & { transcript: string[] } {
  const transcript: string[] = [];
  return {
    transcript,
    async ask(label) {
      throw new Error(
        `this stage needs an answer from the account holder (${label}); an agent must not supply one. ` +
          'Run the stage yourself in a terminal — the command is in the setup status.',
      );
    },
    notify(message) {
      transcript.push(message);
    },
    async confirm() {
      return false;
    },
  };
}

/**
 * The context an MCP surface drives the steps with.
 *
 * Built per CALL, not once at registration: `done` is this run's record and a status read must
 * not see a previous call's stages, and the machine's answers change between calls. `detectSetup`
 * can legitimately fail — a bundle run from somewhere with neither a checkout above it nor
 * `curlew` on PATH — and that is a reported error, not a crash: the caller is told, with the
 * command that fixes it, which is what the core's own message already says.
 */
export function mcpSetupContext(): SetupContext {
  const host = nodeHost();
  return {
    ...detectSetup(host),
    prompter: agentPrompter(),
    host,
    configPath: envValue(process.env, 'CONFIG') ?? setupConfigPath(host),
    indexPath: setupIndexPath(host),
    // The one linking call in the whole run, and here it is a hard stop. See the file header.
    link: async () => {
      throw new Error(
        'an agent must never link a device: the provisioning payload binds the account to this ' +
          'machine and must not enter a tool result. Link it yourself — `curlew setup --only link-signal`.',
      );
    },
    done: new Map(),
  };
}

function findStep(id: string): SetupStep | undefined {
  return SETUP_STEPS.find((step) => step.name === id);
}

export function registerSetupTools(server: McpServer): void {
  // Always registered: it declares itself read-only, so the gate keeps it, and it changes
  // nothing on the machine.
  server.registerTool(
    'setup_status',
    {
      title: 'Setup Status',
      description:
        "Report what `curlew setup` has already done on this machine and what is left, without changing anything: each stage with its state (done, remaining, skipped) and the exact command that performs it, plus the bundle, gjsify, config and enabled backends. Read this before offering to set curlew up, and read it again after a stage — it is how you tell a configured machine from a fresh one. Any `warning` on a stage is a finding about the machine even when the stage itself is done; without GNOME Online Accounts curlew is inert. NEVER returns a pairing code or QR payload: linking is a person's act, and the stages that produce one are marked humanOnly.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return mcpSuccess(await setupStatus(mcpSetupContext()));
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );

  // ONE mutating tool. The step id keeps the action explicit; the gate drops this whole tool
  // unless writes are explicitly allowed, so an agent on a read-only connection cannot reach it
  // at all rather than reaching it and being refused per step.
  server.registerTool(
    'setup_run',
    {
      title: 'Run One Setup Stage',
      description:
        "Run exactly ONE stage of `curlew setup` on this machine, by id. Only available on a server started with CURLEW_MCP_ALLOW_WRITE=1. Every yes/no question is answered NO on your behalf — a stage that needs the account holder to decide reports itself skipped, and you must not try to work around that. The stages `link-signal`, `link-whatsapp` and `terms` REFUSE: the pairing code is the secret that binds an account to this machine, and accepting a third party's terms is an act in the person's name. Do not retry them; hand the user the exact command the refusal names and let them run it. Pass dry_run to see the stage and its state without touching anything.",
      inputSchema: {
        step: z
          .enum(STEP_IDS)
          .describe('The stage to run: ' + SETUP_STEPS.map((s) => `${s.name} (${s.title})`).join(', ')),
        dry_run: z
          .boolean()
          .optional()
          .describe('Report the stage and its current state without running it. Default false.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (params) => {
      try {
        const step = findStep(params.step);
        // The schema cannot produce an unknown id, but a caller that reaches the handler another
        // way gets a refusal that names the real ones instead of a bare "not found".
        if (step === undefined) {
          return mcpError(`unknown setup stage \`${params.step}\` — one of ${SETUP_STEP_IDS.join(', ')}`);
        }
        const ctx = mcpSetupContext();
        if (params.dry_run === true) {
          // A dry run here means "do not run it", not "run it with the writes off". There is no
          // core flag to pass down: a `dryRun` option was declared on `SetupRunOptions` and
          // removed again precisely because no step honoured it — the `unit` stage writes its
          // file before it ever asks a question, so a "dry" run of it would have written
          // something and then reported that it had not. Reporting the stage and its state is
          // the only dry run that is true, and it is decided here, above the core.
          const status = await setupStatus(ctx, [step]);
          return mcpSuccess({ dryRun: true, changed: false, step: status.steps[0] });
        }

        // The refusal, from the core, with the core's command — AFTER the dry run, because a dry
        // run touches nothing and refusing it refuses a read. A person reading this learns why
        // and knows what to do; an agent retrying learns nothing it is allowed to act on.
        if (step.humanOnly === true) return mcpErrorFrom(humanOnlyRefusal(step));
        const result = await runSetup(ctx, { only: [step.name] });
        const outcome = result.steps[0]?.outcome;
        return mcpSuccess({
          dryRun: false,
          step: step.name,
          title: step.title,
          command: step.command,
          ok: result.ok,
          outcome: outcome ?? { status: 'skipped', reason: 'the stage did not run' },
          // The stage's own words, through the prompter it was given. Never a payload: the only
          // stage that could produce one refused above, and `ctx.link` throws if one ever did.
          transcript: (ctx.prompter as SetupPrompter & { transcript: string[] }).transcript,
          remaining: result.remaining,
        });
      } catch (err) {
        return mcpErrorFrom(err);
      }
    },
  );
}
