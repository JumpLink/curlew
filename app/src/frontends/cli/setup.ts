/**
 * `postbote setup` — the terminal side of the eight setup stages.
 *
 * This file is yargs and rendering, and nothing else: which stages exist, what they do and what
 * they are allowed to ask a person all live in `core/actions/setup.ts`. What is added here is
 * the one prompter that drives the whole run, the flags that pick a subset, and a `--status` that
 * prints the same read-only answer an MCP surface will get from `setupStatus`.
 *
 * The prompter is shared: the same object answers this command's questions AND the linking
 * actions', so a QR code reaches the terminal the person is looking at. Nothing here captures
 * output, and nothing here re-implements what a stage already says.
 *
 * Not routed through `runAndExit` for the same reason `daemon` is not: the run decides its own
 * exit code (a stage failed, or the person asked for a listing), and the prompter's readline
 * interface has to be closed either way.
 */

import type { CommandModule } from 'yargs';

import type { SetupContext } from '../../core/actions/setup.ts';
import { SETUP_STEPS, defaultLink, detectSetup, runSetup, setupStatus } from '../../core/actions/setup.ts';
import { nodeHost } from '../../core/actions/setup-host.ts';
import { terminalSetupPrompter } from './prompt.ts';
import { pickArgv } from './output.ts';

export const setupCommand: CommandModule = {
  command: 'setup',
  describe:
    'Walk through putting postbote to work on this machine — link a device, accept the terms, build the index, install the systemd unit',
  builder: (yargs) =>
    yargs
      .option('only', {
        type: 'array',
        string: true,
        describe: `Run only these stages, by name: ${SETUP_STEPS.map((s) => s.name).join(', ')}`,
      })
      .option('status', {
        type: 'boolean',
        default: false,
        describe: 'Report what is done and what is left, without changing anything',
      })
      .option('bail', {
        type: 'boolean',
        default: false,
        describe: 'Stop after the first stage that does not finish',
      }),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    const prompter = terminalSetupPrompter();
    const host = nodeHost();
    // One prompter for the whole run — the wizard's own questions and the backends' logins are
    // answered by the same object, and one readline interface owns stdin (see prompt.ts).
    const where = detectSetup(host);
    const ctx: SetupContext = {
      ...where,
      prompter,
      host,
      configPath: process.env.POSTBOTE_CONFIG ?? defaultConfigPath(host),
      indexPath: defaultIndexPath(host),
      link: defaultLink,
      done: new Map(),
    };
    run(ctx, {
      only: pickArgv<string[]>(raw, 'only'),
      status: pickArgv<boolean>(raw, 'status') === true,
      bail: pickArgv<boolean>(raw, 'bail') === true,
    })
      .then((code) => {
        prompter.close();
        process.exit(code);
      })
      .catch((err: unknown) => {
        prompter.close();
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      });
  },
};

interface RunOptions {
  only?: string[] | undefined;
  status: boolean;
  bail: boolean;
}

async function run(ctx: SetupContext, options: RunOptions): Promise<number> {
  if (options.status) {
    const status = await setupStatus(ctx);
    printStatus(ctx, status);
    return 0;
  }
  // Note there is no `humanOnly` gate here, and there must not be one: a person typing
  // `--only terms` in their own terminal IS the person the flag exists for. `humanOnly` is about
  // the OTHER surfaces — an agent must not be able to run the three stages that are a human act
  // (see `humanOnlyRefusal`), and the flag every such surface quotes is this command.
  const result = await runSetup(ctx, { only: options.only, bail: options.bail });
  await reportRemaining(ctx, result.remaining);
  return result.ok ? 0 : 1;
}

/** After a run, print what is still outstanding — the invocations, so they can be copied. */
async function reportRemaining(ctx: SetupContext, remaining: readonly string[]): Promise<void> {
  if (remaining.length === 0) return;
  await ctx.prompter.notify('');
  await ctx.prompter.notify('  Still to run:');
  for (const command of remaining) await ctx.prompter.notify(`    ${command}`);
}

function printStatus(ctx: SetupContext, status: Awaited<ReturnType<typeof setupStatus>>): void {
  const { readiness } = status;
  const rows: [string, string][] = [
    ['mode', readiness.mode],
    ['checkout', readiness.checkout ?? '—'],
    ['bundle', readiness.bundle ?? 'not found'],
    ['gjsify', readiness.gjsify ?? 'not on PATH'],
    ['config', `${readiness.configPath}${readiness.configExists ? '' : ' (not written yet)'}`],
    ['enabled backends', readiness.enabled.join(', ') || 'none'],
  ];
  // stdout for the report: a `--status` is the one thing here that is read, not asked, and a
  // person may well pipe it.
  console.log('postbote setup — what is done and what is left\n');
  for (const [key, value] of rows) console.log(`  ${key.padEnd(18)}${value}`);
  console.log('');
  for (const step of status.steps) {
    const mark = step.state === 'done' ? '✓' : step.state === 'skipped' ? '-' : '·';
    const human = step.humanOnly ? ' (you only)' : '';
    console.log(`  ${mark} ${step.title}${human}`);
    console.log(`      ${step.state} — ${step.command}`);
  }
  console.log('');
  console.log(`  ${status.done} of ${status.steps.length} stages done`);
  if (status.remaining.length > 0) {
    console.log('');
    console.log('  Still to run:');
    for (const command of status.remaining) console.log(`    ${command}`);
  }
}

/** `$XDG_CONFIG_HOME/postbote/config.json`, XDG-correct — the same rule as `@postbote/store`. */
function defaultConfigPath(host: ReturnType<typeof nodeHost>): string {
  const xdg = host.env('XDG_CONFIG_HOME');
  const base = xdg !== undefined && xdg !== '' ? xdg : `${host.home()}/.config`;
  return `${base}/postbote/config.json`;
}

/** `$XDG_DATA_HOME/postbote/index.db`, for the same reason. */
function defaultIndexPath(host: ReturnType<typeof nodeHost>): string {
  const xdg = host.env('XDG_DATA_HOME');
  const base = xdg !== undefined && xdg !== '' ? xdg : `${host.home()}/.local/share`;
  return `${base}/postbote/index.db`;
}
