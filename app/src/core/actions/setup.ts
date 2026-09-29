/**
 * `postbote setup` — walk a person through putting postbote to work on a machine.
 *
 * Eight stages, a decision at each, re-runnable: a second run detects what is already done and
 * says so instead of failing. This module holds ALL of the logic and NO yargs and NO terminal:
 * a list of named steps, each `run(ctx)`, driven by an injected prompter. The yargs command and
 * the rendering live in `app/src/frontends/cli/setup.ts`.
 *
 * WHY the prompter is the seam, and it has to stay one: an Adwaita UI for device linking is
 * planned, and it must drive these same steps with widgets instead of text. So a step never
 * reaches for `process.stdout` — if a step seems to need one, it needs a prompter method
 * instead. One `SetupPrompter` serves the whole run, including the backend logins: the linking
 * actions (`accountsAdd`) get the same object the wizard's own questions go through, which is why
 * the QR lands on the person's screen without a step ever seeing it.
 *
 * SECURITY — a stage must never break it:
 *
 *   The QR code and pairing code are the credential: whoever scans it owns the linked device.
 *   It is rendered by the backend itself (a pure function of the provisioning payload) and
 *   printed through `prompter.notify`, so `setup` gets it for free by CALLING THE EXISTING
 *   ACTION with the shared prompter instead of re-implementing a link. What must never happen:
 *
 *     * a step wraps a linking call in output capture, a `tee` or a file redirect — the
 *       SetupPrompter is shared and the linking output goes to the prompter, never through
 *       `host.run({ capture: true })`;
 *     * a payload reaches a log, an error message or a journal entry. The steps' messages are
 *       their own words, never a backend's output;
 *     * a pairing secret is persisted. Nothing here writes a session; `ask()` is used for a
 *       filesystem path only, which is not a secret and is echoed as typed.
 *
 *   The one place a command's output is ever captured is `systemd-analyze --user verify` on a
 *   unit FILE this action wrote. A unit file is systemd configuration; no linking session is in
 *   it and none can be.
 */

import type { AccountPrompter } from '@postbote/protocol';
import type { CommandRunner } from './setup-host.ts';
import { accountsAdd } from './accounts.ts';

/**
 * How a setup run talks to a person. `AccountPrompter` is the shape a backend login takes; the
 * wizard adds the one thing a login never needs and a wizard cannot do without — a yes/no
 * question. The terminal implementation satisfies both, and the SAME object is handed to the
 * linking actions.
 */
export interface SetupPrompter extends AccountPrompter {
  /** Ask a yes/no question. The default answer is no: an unanswered question must never enable
   * a backend, accept a term or install a unit. */
  confirm(question: string): Promise<boolean>;
}

/** Which postbote is being set up. A checkout needs gjsify and a built bundle; a published
 * install needs neither. */
export type SetupMode = 'checkout' | 'published';

/** What a step did, so the next stage and the final report can use it without re-asking. */
export type SetupOutcome =
  /** The stage did its work. */
  | { status: 'done'; detail?: string }
  /** The person declined, or the thing was already in place. Never an error. */
  | { status: 'skipped'; reason: string }
  /** The stage could not finish. Carries the reason, never a payload or a backend's output. */
  | { status: 'failed'; reason: string }
  /** Not implemented yet — announced so the stage list is inspectable while the body lands. */
  | { status: 'todo'; reason: string };

/** What the run tells a step about the machine. Everything a step may touch is in here, so a
 * test drives the whole run with a fake host and a fake prompter. */
export interface SetupContext {
  readonly mode: SetupMode;
  /** Absolute path of the checkout, or null for a published install. */
  readonly checkout: string | null;
  readonly prompter: SetupPrompter;
  readonly host: CommandRunner;
  /** The config file to work on. The default is the user's; a test points it at a throwaway. */
  readonly configPath: string;
  /**
   * Link a device on a backend. Defaults to the real `accountsAdd`; a test substitutes a stub so
   * the QR never has to be real. It takes the SHARED prompter and returns nothing about the
   * payload — that is the whole security property, so the seam is explicit rather than a hidden
   * import.
   */
  link(backend: string, prompter: SetupPrompter): Promise<void>;
  /** Set by a step, read by later ones. */
  readonly done: Map<string, SetupOutcome>;
}

export interface SetupStep {
  /** Stable id, kebab-case — the `--only` filter and the report key it. */
  readonly name: string;
  /** One line, shown as the stage heading. */
  readonly title: string;
  run(ctx: SetupContext): Promise<SetupOutcome>;
}

/**
 * The eight stages, in order. The shell wizard this replaces ran the same eight, with the same
 * wording decisions: terms are displayed before they are accepted, `sync` is named as the only
 * writer of the index, and the phone is driven instead of a browser.
 */
export const SETUP_STEPS: readonly SetupStep[] = [
  { name: 'readiness', title: 'Readiness: bundle, tools, live check', run: todo('readiness') },
  { name: 'link-signal', title: 'Link Signal', run: todo('link-signal') },
  { name: 'link-whatsapp', title: 'Link WhatsApp (optional)', run: todo('link-whatsapp') },
  { name: 'terms', title: 'Enable backends — read the terms first', run: todo('terms') },
  { name: 'index', title: 'Build the index', run: todo('index') },
  { name: 'daemon', title: 'The receiving daemon', run: todo('daemon') },
  { name: 'unit', title: 'Install the systemd user unit', run: todo('unit') },
  { name: 'finish', title: 'Finish: what runs now, what is left', run: todo('finish') },
];

function todo(name: string): (ctx: SetupContext) => Promise<SetupOutcome> {
  return async (ctx) => {
    await ctx.prompter.notify(`  ${SETUP_STEPS.find((s) => s.name === name)?.title ?? name}`);
    return { status: 'todo', reason: 'not implemented yet' };
  };
}

export interface SetupRunOptions {
  /** Run only these stages, by name; the default is all of them, in order. */
  only?: readonly string[];
  /** Report what would be done without changing anything. A step that writes gets a dry run. */
  dryRun?: boolean;
  /** Stop after the first stage that did not finish. The default is false: one failure must not
   * hide the rest of the report. */
  bail?: boolean;
}

export interface SetupRunResult {
  /** The stages, in the order they ran. */
  readonly steps: { name: string; title: string; outcome: SetupOutcome }[];
  /** True when no stage failed. */
  readonly ok: boolean;
  /** The follow-ups that are this machine's to do, in the order the finish stage lists them. */
  readonly followUps: readonly string[];
}

/** The follow-ups, whatever the machine. Named here so a frontend cannot lose or reorder them. */
export const SETUP_FOLLOW_UPS: readonly string[] = [
  'Back up $XDG_DATA_HOME/postbote: with Signal or WhatsApp enabled the index is irreplaceable ' +
    '(those networks keep no archive), and the files under secrets/ are secrets — back them up ' +
    'like a password, never share them.',
  'loginctl enable-linger "$USER" so the daemon also runs while you are logged out; that is ' +
    'what lets a user unit run at all without a session.',
  'Check the daemon after a few days: `postbote deliveries`, or journalctl --user -u ' +
    'postbote-daemon. A unit sitting at exit 2 means every account was logged out — relink, ' +
    'then systemctl --user restart postbote-daemon.',
  'End a linked device from the phone (Settings → Linked devices). Deleting the session file ' +
    'under secrets/ ends it on this machine.',
  'A sync from a timer is the fallback for a machine where the daemon does not run — but not ' +
    'both at once: they take a lease on the same accounts.',
  'Bump @gjsify/* to 0.53: it carries the long-lived-connection fix, and the three gjsify shims ' +
    'in the tree (addon-canary, download, the module-resolve workaround) go away with it.',
  'An Adwaita UI drives these same setup steps with widgets instead of text — the reason the ' +
    'steps carry no yargs and no terminal.',
];

/**
 * Run the stages. The driver is the whole point of the split: it announces each stage through
 * the prompter, calls `run(ctx)`, and records the outcome. It decides nothing else, so a future
 * frontend can render the same list as a wizard window, a checklist or a `--only` filter.
 */
export async function runSetup(ctx: SetupContext, options: SetupRunOptions = {}): Promise<SetupRunResult> {
  const wanted = options.only === undefined ? null : new Set(options.only);
  const steps: SetupRunResult['steps'][number][] = [];
  let ok = true;
  for (const step of SETUP_STEPS) {
    if (wanted !== null && !wanted.has(step.name)) continue;
    await ctx.prompter.notify('');
    await ctx.prompter.notify(`▸ ${step.title}`);
    let outcome: SetupOutcome;
    try {
      outcome = await step.run(ctx);
    } catch (err: unknown) {
      // A step's own failure is a failed STAGE, not a dead run: the remaining stages are
      // independent, and the person decides whether to continue. The message is the error's
      // message, which is the step's own wording — never a payload and never backend output.
      outcome = { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
    }
    ctx.done.set(step.name, outcome);
    steps.push({ name: step.name, title: step.title, outcome });
    if (outcome.status === 'failed') {
      ok = false;
      if (options.bail) break;
    }
  }
  return { steps, ok, followUps: SETUP_FOLLOW_UPS };
}

/** The default linker: the existing action, with the SHARED prompter. This is the whole reason
 * `setup` never has to know what a QR looks like. */
export const defaultLink = async (backend: string, prompter: SetupPrompter): Promise<void> => {
  await accountsAdd(backend, prompter);
};
