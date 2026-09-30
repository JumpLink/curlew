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
import { accountsAdd, accountsCheck, backendAccountsList } from './accounts.ts';
import { backendsEnable, backendsList } from './backends.ts';
import { runDeliveryDaemon } from './daemon.ts';
import { indexStatus, indexSync } from './index-sync.ts';
import { runtimeName } from '../runtime.ts';
import type { CommandRunner } from './setup-host.ts';
import { systemdUserUnitDir, writeFileEnsured } from './setup-host.ts';
import type { UnitPaths } from './setup-unit.ts';
import { UNIT_NAME, renderUnit, unitFilePath, unitPathsFor } from './setup-unit.ts';

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

/**
 * What a step did, so the next stage and the final report can use it without re-asking.
 *
 * `warning` is the reason this is not three bare literals. A step whose CHECKS RAN but found
 * something wrong — the readiness stage reaching a machine with no session bus at all — completes,
 * so `status: 'done'` is the truth, and `done` alone is a lie the status surface repeats. Measured
 * on this file before `warning` existed: `postbote setup --status` with `DBUS_SESSION_BUS_ADDRESS`
 * pointing at nothing printed `done` for readiness and nothing else, because the stage said
 * "GNOME Online Accounts: unavailable" through `prompter.notify` — a word only the interactive
 * stream ever saw. Without GOA the whole product is inert, and it is inert QUIETLY, so the fact
 * has to travel in the value every surface reads rather than in a line a person might not be there
 * to see. The same reasoning as `humanOnly` living on the step: the core carries the fact, each
 * frontend renders it, and the two cannot drift.
 */
export type SetupOutcome =
  /** The stage did its work. */
  | { status: 'done'; detail?: string; warning?: string }
  /** The person declined, or the thing was already in place. Never an error. */
  | { status: 'skipped'; reason: string; warning?: string }
  /** The stage could not finish. Carries the reason, never a payload or a backend's output. */
  | { status: 'failed'; reason: string; warning?: string };

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
  /** The index to report on and to sync. Injected so a test never reads the user's. */
  readonly indexPath: string;
  /**
   * Link a device on a backend. The frontend supplies the real `accountsAdd`; a test substitutes
   * a stub so the QR never has to be real. It takes the SHARED prompter and returns nothing
   * about the payload — that is the whole security property, so the seam is explicit rather than
   * a hidden import, and a step cannot reach past it.
   */
  link(backend: string, prompter: SetupPrompter): Promise<void>;
  /**
   * How many accounts a backend knows — a COUNT, never an id and never a session file. A seam for
   * the same reason `link` is one: the terms stage's promise (display, then ask, then accept) is a
   * security claim about a path only a linked account can reach, so a test has to be able to
   * stand on it. Defaults to the real listing.
   */
  countAccounts?(backend: string): Promise<number>;
  /**
   * Probe GNOME Online Accounts — `{ ok, message }`, never a throw. A seam for the same reason
   * `link` and `countAccounts` are ones: the readiness stage's warning is only a testable fact if
   * a test can put "no session bus at all" on a machine that HAS accounts, and it must stay that
   * way on the Node run too (where the probe reports unavailable by definition). Defaults to the
   * real `accountsCheck`.
   */
  checkAccounts?(): Promise<{ ok: boolean; message: string }>;
  /** Set by a step, read by later ones. */
  readonly done: Map<string, SetupOutcome>;
}

/** Where the unit for this run goes, and the paths it names. Derived from the run rather than
 * passed in twice: readiness, the unit stage and the status probe must agree on all three. */
export function unitDir(ctx: SetupContext): string {
  return systemdUserUnitDir(ctx.host);
}

export function unitFilePathFor(ctx: SetupContext): string {
  return unitFilePath(unitDir(ctx));
}

export function unitPaths(ctx: SetupContext): UnitPaths {
  return unitPathsFor({
    mode: ctx.mode,
    home: ctx.host.home(),
    checkout: ctx.checkout,
    gjsify: ctx.host.which('gjsify'),
    bundle: ctx.host.bundlePath(),
  });
}

/**
 * Where a step stands, as a read-only surface may report it.
 *
 * `done` is not "the wizard said so" — it is the machine's own state wherever that is
 * observable. `skipped` is a person having declined, which is a real answer and not a failure.
 */
export type SetupStepState = 'done' | 'remaining' | 'skipped';

export interface SetupStep {
  /** Stable id, kebab-case — the `--only` filter and the report key it. */
  readonly name: string;
  /** One line, shown as the stage heading. */
  readonly title: string;
  /**
   * The exact invocation that performs THIS ONE step for a person.
   *
   * It is not decoration: a step that cannot be run on its own cannot be handed to someone
   * ("run this and tell me what it says") and cannot be refused by a surface that must not do
   * it. So the id, this command and `--only <name>` are three names for one thing, and a
   * surface quotes this string rather than composing its own advice.
   */
  readonly command: string;
  /**
   * A human act on EVERY surface, not an agent's — set on the steps that must never be
   * automated:
   *
   *   - the two linking steps, because the provisioning payload is the secret that binds a
   *     person's account to this machine and must never enter an agent's context: a human
   *     holds the phone, an agent must never see the code that unlocks it;
   *   - `terms`, because accepting a third party's terms is an act that carries the person's
   *     name on it. It is not the agent's to accept.
   *
   * Undefined means false: a step with no `humanOnly` may be driven by any surface.
   */
  readonly humanOnly?: boolean;
  run(ctx: SetupContext): Promise<SetupOutcome>;
  /**
   * Read what the machine looks like RIGHT NOW, without changing it. Only for a step whose
   * done-ness is observable from the outside; a step without one reports what this run
   * recorded, or `remaining`. A probe that throws reports `remaining` — a status read must
   * never be the thing that fails.
   *
   * It reports a `warning` alongside the `state` for the same reason `SetupOutcome` has one: a
   * check that RAN and found the machine inert has still completed, so the state is `done` and
   * the finding rides next to it. Returning a bare state is still valid — a step with nothing to
   * report says only that.
   */
  probe?(ctx: SetupContext): Promise<SetupStepState | SetupProbe>;
}

/** A probe's answer: the state, plus anything the read learned that the state cannot express. */
export interface SetupProbe {
  readonly state: SetupStepState;
  readonly warning?: string;
}

/**
 * The eight stages, in order. The shell wizard this replaces ran the same eight, with the same
 * wording decisions: terms are displayed before they are accepted, `sync` is named as the only
 * writer of the index, and the phone is driven instead of a browser.
 */
/** The report stage, by id: a stage must be able to name itself without counting its own index. */
export const FINISH_STAGE = 'finish';

export const SETUP_STEPS: readonly SetupStep[] = [
  readinessStep(),
  // The terms come before the QR, not after. Adding an account needs an enabled backend, so a
  // link attempted first could only ever fail — and the person was told at the end that they had
  // no linked account, which reads as declining rather than as a stage that never ran. Consent
  // first is also the honest order for the terms themselves: they say what the daemon may read
  // from this backend, and reading them before handing over the account is the point of them.
  termsStep(),
  linkStep('signal', 'Link Signal', 'Signal → Settings → Linked devices → Link new device.'),
  linkStep('whatsapp', 'Link WhatsApp (optional)', 'WhatsApp → Linked devices → Link a device.'),
  indexStep(),
  daemonStep(),
  unitStep(),
  finishStep(),
];

/** The backends a setup run offers to enable, in the order the stages run. */
export const SETUP_LINK_BACKENDS = ['signal', 'whatsapp'] as const;

const SECRET_NOTE =
  'The pairing code is a secret: it binds your account to this machine. Do not copy, paste or ' +
  'send it — it is shown here, it is scanned from here, and it goes nowhere else.';

// ── 1. readiness ─────────────────────────────────────────────────────────────

/**
 * The live GOA/EDS check, and what a machine without it means.
 *
 * One function for both paths, because the defect this replaced was a split brain: `run` asked
 * the question and answered it out loud, `probe` never asked it, and `setup --status` — which
 * only probes — reported a machine that cannot read a single account as `done` with nothing else
 * said about it. The word is `unavailable`, not `not ready`: the check DID run and DID complete,
 * which is why `state` stays `done` and only the warning carries the finding. Anything softer
 * ("not ready") would make the assertion below pass while the fact stopped being legible.
 */
const GOA_WARNING = 'GNOME Online Accounts: unavailable';

async function goaWarning(ctx: SetupContext): Promise<string | undefined> {
  try {
    const result = await (ctx.checkAccounts ?? accountsCheck)();
    if (result.ok) return undefined;
    return `${GOA_WARNING} — ${result.message}`;
  } catch (err: unknown) {
    return `${GOA_WARNING} — ${err instanceof Error ? err.message : String(err)}`;
  }
}

function readinessStep(): SetupStep {
  return {
    name: 'readiness',
    title: 'Readiness: bundle, tools, live check',
    command: 'postbote setup --only readiness',
    async probe(ctx) {
      const readiness = setupReadiness(ctx);
      // The warning rides along with the state, so `--status` and an agent's `setup_status` see
      // the same finding a person would be told at the keyboard.
      if (readiness.mode === 'published') return { state: 'done', warning: await goaWarning(ctx) };
      if (readiness.bundle === null || !ctx.host.exists(readiness.bundle)) {
        return { state: 'remaining', warning: await goaWarning(ctx) };
      }
      if (readiness.gjsify === null) {
        return { state: 'remaining', warning: await goaWarning(ctx) };
      }
      return { state: 'done', warning: await goaWarning(ctx) };
    },
    async run(ctx) {
      const say = async (line: string): Promise<void> => ctx.prompter.notify(`  ${line}`);
      await say(
        'This walkthrough links your devices, builds the index and starts the receiving daemon ' +
          'as a systemd user unit. Stop at any time and re-run it — a second run says what is ' +
          'already done.',
      );
      const readiness = setupReadiness(ctx);
      if (readiness.mode === 'checkout') {
        await say(`Checkout: ${readiness.checkout}`);
        if (readiness.gjsify === null) {
          // Never build from in here: a command cannot build itself, and the fix is one the
          // person runs in another process. Say exactly that, and name the command.
          return {
            status: 'failed',
            reason:
              'gjsify is not on PATH, and both the bundle and the unit need it. Install it with ' +
              '`npm install -g @gjsify/cli`, then run this again.',
          };
        }
        await say(`gjsify: ${readiness.gjsify}`);
        if (readiness.bundle === null) {
          return {
            status: 'failed',
            reason:
              'this process cannot name the bundle it is running from, and the unit needs that ' +
              'path. Run `postbote setup` from a built checkout, or from the installed command.',
          };
        }
        if (!ctx.host.exists(readiness.bundle)) {
          return {
            status: 'failed',
            reason:
              `no bundle at ${readiness.bundle}. Build it with ` +
              '`gjsify workspace postbote-cli build`, then run this again — a command does not ' +
              'build itself.',
          };
        }
        await say(`Bundle: ${readiness.bundle}`);
      } else {
        await say('Published install: the installed command is used as it is. No checkout needed.');
      }
      await say('Live check (reads your online accounts, writes nothing):');
      // A probe can fail — no session bus, no typelib — and one failed probe is a REPORTED
      // check, never a thrown stage: readiness says what is missing, it does not stop the walk.
      const runtime = runtimeName();
      await say(`  runtime: ${runtime}${runtime === 'gjs' ? '' : ' — the GNOME backends need GJS'}`);
      // No `say()` for the verdict: the finding travels in the outcome, so the driver prints it
      // once for every surface and a read-only one (`--status`, an agent's `setup_status`) is not
      // left with a `done` that means nothing.
      return { status: 'done', detail: 'readiness', warning: await goaWarning(ctx) };
    },
  };
}

// ── 2 + 3. link a device ─────────────────────────────────────────────────────

function linkStep(backend: string, title: string, phoneSteps: string): SetupStep {
  const display = backend === 'signal' ? 'Signal' : 'WhatsApp';
  return {
    name: `link-${backend}`,
    title,
    command: `postbote setup --only link-${backend}`,
    humanOnly: true,
    async probe(ctx) {
      return (await linkedCount(ctx, backend)) > 0 ? 'done' : 'remaining';
    },
    async run(ctx) {
      const say = async (line: string): Promise<void> => ctx.prompter.notify(`  ${line}`);
      if ((await linkedCount(ctx, backend)) > 0) {
        await say(`${display} is already linked on this machine — nothing to do.`);
        return { status: 'done', detail: 'already linked' };
      }
      await say(
        'postbote registers itself with your phone as a linked device. The QR code appears ' +
          'below, in this terminal.',
      );
      await say(`On the phone: ${phoneSteps}`);
      await say(SECRET_NOTE);
      if (!(await ctx.prompter.confirm(`Link ${display} now?`))) {
        return { status: 'skipped', reason: `not linking ${display} now` };
      }
      // The ONE call in this module that produces a pairing payload. It is the existing action,
      // in-process, with the SHARED prompter: the backend renders the QR and hands it to
      // `prompter.notify`, and nothing here ever sees, captures, logs or stores it. That is the
      // whole reason this is TypeScript and not a shell script that shelled out to a subprocess
      // and hoped its output stayed on the terminal.
      await ctx.link(backend, ctx.prompter);
      const count = await linkedCount(ctx, backend);
      if (count === 0) {
        // Not a failure: a pairing can be declined on the phone, and the person holding it is
        // the only one who knows. The terms stage asks again rather than inferring.
        return { status: 'skipped', reason: `${display} reports no linked account yet` };
      }
      return { status: 'done', detail: `${count} ${display} account(s)` };
    },
  };
}

/** The default counter: the real listing, and only its length. Constructing a backend can fail
 * (no addon for this platform, no session file yet) and that is "none linked", not an error — a
 * stage that cannot count must not claim the machine is broken. */
const defaultCountAccounts = async (ctx: SetupContext, backend: string): Promise<number> => {
  try {
    const { accounts } = await backendAccountsList(backend, ctx.configPath);
    return accounts.length;
  } catch {
    return 0;
  }
};

// ── 4. terms ─────────────────────────────────────────────────────────────────

function termsStep(): SetupStep {
  return {
    name: 'terms',
    title: 'Enable backends — read the terms first',
    command: 'postbote setup --only terms',
    humanOnly: true,
    async probe(ctx) {
      const enabled = enabledBackends(ctx.configPath);
      return SETUP_LINK_BACKENDS.every((name) => enabled.includes(name)) ? 'done' : 'remaining';
    },
    async run(ctx) {
      const say = async (line: string): Promise<void> => ctx.prompter.notify(`  ${line}`);
      await say(
        'The daemon only receives what is enabled here. A first enable shows the terms the ' +
          'backend asks you to accept — read them yourself before you accept them.',
      );
      let enabledAny = false;
      for (const backend of SETUP_LINK_BACKENDS) {
        // The first enable is the one WITHOUT the acceptance. It changes nothing: the registry
        // returns the notice together with the config unchanged. So the terms are on screen
        // before the question, and no code path here accepts on the person's behalf.
        const first = backendsEnable(backend, { path: ctx.configPath });
        if (first.outcome === 'already-enabled') {
          await say(`${backend}: already enabled, terms accepted.`);
          enabledAny = true;
          continue;
        }
        // The notice goes on screen before anything else is decided, whether or not a device is
        // linked: a person who declines here has still read what the terms are.
        if (first.terms !== null) {
          await say(`${backend} asks you to accept these terms:`);
          await say(`  ${first.terms.summary}`);
          if (first.terms.url !== undefined) await say(`  ${first.terms.url}`);
        }
        // Ask, do not infer: a finished account listing cannot say whether the phone accepted the
        // QR, and only the person holding the phone knows that. So the question is asked — and it
        // is asked here, a stage that is `humanOnly` on every surface.
        //
        // Deliberately NOT gated on a linked account. It used to be, and that made the whole
        // procedure unreachable: this stage waited for the link, and the link needed the backend
        // this stage enables. `registry.enable` asks only for the terms — an enabled backend with
        // no session is what the daemon calls `loggedOut` — so asking here costs nothing and
        // closes nothing.
        if (!(await ctx.prompter.confirm(`Read the terms for ${backend} and accept them?`))) {
          await say(`${backend} stays disabled.`);
          continue;
        }
        const accepted = backendsEnable(backend, { path: ctx.configPath, acceptTerms: true });
        if (accepted.outcome === 'enabled' || accepted.outcome === 'already-enabled') {
          await say(`${backend}: enabled.`);
          enabledAny = true;
        } else {
          await say(`${backend}: could not be enabled (${accepted.outcome}).`);
        }
      }
      if (!enabledAny) {
        return { status: 'skipped', reason: 'no delivery backend is enabled — nothing to receive' };
      }
      return { status: 'done', detail: 'backends enabled' };
    },
  };
}

// ── 5. the index ─────────────────────────────────────────────────────────────

function indexStep(): SetupStep {
  return {
    name: 'index',
    title: 'Build the index',
    command: 'postbote setup --only index',
    async probe(ctx) {
      // Built-ness is observable: the index exists and holds mail. No file, or an empty one, is
      // `remaining` — never a guess that the walkthrough did it.
      return indexedMessages(ctx) > 0 ? 'done' : 'remaining';
    },
    async run(ctx) {
      const say = async (line: string): Promise<void> => ctx.prompter.notify(`  ${line}`);
      await say(
        'postbote searches the local index, not the network, and `postbote sync` is the only ' +
          'thing that writes it — this stage IS that one call, not a second writer.',
      );
      await say('It reads the headers of your mail accounts, never a body.');
      const existing = indexedMessages(ctx);
      if (existing > 0) {
        await say(`The index already holds ${existing} message(s); syncing again only updates it.`);
      }
      await say('With many accounts this takes a few minutes.');
      if (!(await ctx.prompter.confirm('Build the index now?'))) {
        return { status: 'skipped', reason: 'the index stays as it is' };
      }
      const result = await indexSync({ configPath: ctx.configPath, dbPath: ctx.indexPath });
      return {
        status: 'done',
        detail:
          `${indexedMessages(ctx)} message(s), ${result.conversations.conversations} conversation(s), ` +
          `from ${result.backends.join(', ') || 'no enabled backend'}`,
      };
    },
  };
}

/** How many messages the index holds, or 0 when it cannot be opened. Never a throw: the index
 * not existing yet is the normal state before the index stage. */
function indexedMessages(ctx: SetupContext): number {
  try {
    return indexStatus(ctx.indexPath).messages;
  } catch {
    return 0;
  }
}

// ── 6. the daemon ────────────────────────────────────────────────────────────

/** How long the smoke run receives before it asks itself to stop. */
export const SETUP_DAEMON_SMOKE_SECONDS = 30;

function daemonStep(): SetupStep {
  return {
    name: 'daemon',
    title: 'The receiving daemon',
    command: 'postbote setup --only daemon',
    async probe(ctx) {
      // A daemon is "set up" when the unit that runs it is enabled — that is what makes it
      // receive while nobody is watching, which is the entire point of it.
      return ctx.host.run(['systemctl', '--user', 'is-enabled', UNIT_NAME]).code === 0 ? 'done' : 'remaining';
    },
    async run(ctx) {
      const say = async (line: string): Promise<void> => ctx.prompter.notify(`  ${line}`);
      const receiving = enabledBackends(ctx.configPath).filter(
        (name) => name === 'signal' || name === 'whatsapp',
      );
      if (receiving.length === 0) {
        return {
          status: 'skipped',
          reason: 'no delivery backend is enabled — the daemon refuses to start without one',
        };
      }
      await say(
        'The daemon receives in the background without walking the index, and keeps going while you do nothing.',
      );
      await say(
        `Receiving from ${receiving.join(', ')} for ${SETUP_DAEMON_SMOKE_SECONDS} seconds, then it ` +
          'stops itself.',
      );
      await say(
        'Expect one line per account as it connects — account ids, never phone numbers or message text.',
      );
      if (!(await ctx.prompter.confirm('Run the daemon briefly now?'))) {
        return { status: 'skipped', reason: 'not started — the systemd unit is the real receiver' };
      }
      // In-process, bounded, and through the daemon's OWN stop: an AbortSignal is exactly what
      // SIGTERM delivers in `postbote daemon`, so this reuses that path rather than implementing
      // "stop after N seconds" a second time around a child process. What the shell wizard did —
      // leave the foreground run to a human's Ctrl-C — is the one thing a command cannot do, and
      // skipping the run entirely would leave unverified the only thing the unit cannot show:
      // that the backends load and connect at all.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SETUP_DAEMON_SMOKE_SECONDS * 1000);
      try {
        const result = await runDeliveryDaemon({
          configPath: ctx.configPath,
          dbPath: ctx.indexPath,
          signal: controller.signal,
          rebuildDebounceMs: 0,
          // Through the prompter, like every other word this run says. The daemon's own log
          // contract is counts, ids and states only, so nothing a peer wrote can get in here.
          log: (line: string) => void ctx.prompter.notify(`  ${line}`),
        });
        const dead = result.accounts.filter((a) => a.loggedOut || a.error !== null);
        if (dead.length > 0) {
          return {
            status: 'failed',
            reason:
              `${dead.length} account(s) received nothing — relink the device, then run ` +
              `\`postbote setup --only daemon\` again`,
          };
        }
        return {
          status: 'done',
          detail: `${result.added} message(s) received, every loop closed, index closed cleanly`,
        };
      } catch (err: unknown) {
        return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ── 7. the systemd unit ─────────────────────────────────────────────────────

function unitStep(): SetupStep {
  return {
    name: 'unit',
    title: 'Install the systemd user unit',
    command: 'postbote setup --only unit',
    async probe(ctx) {
      return ctx.host.exists(unitFilePathFor(ctx)) ? 'done' : 'remaining';
    },
    async run(ctx) {
      const say = async (line: string): Promise<void> => ctx.prompter.notify(`  ${line}`);
      await say('This runs the daemon without a terminal, and starts it with your session.');
      const target = unitFilePathFor(ctx);
      writeFileEnsured(ctx.host, target, renderUnit(unitPaths(ctx)));
      await say(`Written: ${target}`);
      // The ONE place a command's output is ever captured, and what it captures is a FILE
      // CHECK: a unit file is systemd configuration, no linking session is in it and none can be.
      const verified = ctx.host.run(['systemd-analyze', '--user', 'verify', target], { capture: true });
      if (verified.output.trim() !== '') await ctx.prompter.notify(verified.output.trimEnd());
      // systemd-analyze's OWN exit code decides the stage. Piped through a `head`, a shell loses
      // it, and a unit that does not verify must never be offered for enable.
      if (verified.code !== 0) {
        return { status: 'failed', reason: `systemd-analyze --user verify exited ${verified.code}` };
      }
      await say('systemd-analyze --user verify: exit 0, nothing to report.');
      if (ctx.host.run(['systemctl', '--user', 'is-enabled', UNIT_NAME]).code === 0) {
        await say(`${UNIT_NAME} is already enabled — leaving it as it is.`);
        return { status: 'done', detail: 'unit written, already enabled' };
      }
      if (!(await ctx.prompter.confirm('Enable and start the unit now?'))) {
        return { status: 'skipped', reason: 'the unit is written but not enabled' };
      }
      ctx.host.run(['systemctl', '--user', 'daemon-reload']);
      const enable = ctx.host.run(['systemctl', '--user', 'enable', '--now', UNIT_NAME]);
      if (enable.code !== 0) {
        return { status: 'failed', reason: `systemctl --user enable --now exited ${enable.code}` };
      }
      await say(`${UNIT_NAME} is enabled and running.`);
      await say('When in doubt: journalctl --user -u postbote-daemon -f');
      await say(
        `Without a session it still needs: loginctl enable-linger "${ctx.host.env('USER') ?? '$USER'}"`,
      );
      return { status: 'done', detail: 'unit installed, enabled and started' };
    },
  };
}

// ── 8. the report ───────────────────────────────────────────────────────────

function finishStep(): SetupStep {
  return {
    name: FINISH_STAGE,
    title: 'Finish: what runs now, what is left',
    command: `postbote setup --only ${FINISH_STAGE}`,
    async run(ctx) {
      const say = async (line: string): Promise<void> => ctx.prompter.notify(`  ${line}`);
      const status = await setupStatus(ctx);
      // The status was read BEFORE this stage recorded itself, so it would otherwise report its
      // own line as outstanding — the one line it is about to finish.
      const mine = `postbote setup --only ${FINISH_STAGE}`;
      await say('What runs now:');
      for (const step of status.steps) {
        const state = step.command === mine ? 'done' : step.state;
        await say(`  ${state === 'done' ? '✓' : '·'} ${step.title} — ${state}`);
        if (step.command !== mine && step.warning !== undefined) await say(`      ⚠ ${step.warning}`);
      }
      await say('Keep going on your own:');
      for (const followUp of SETUP_FOLLOW_UPS) await say(`  • ${followUp}`);
      const outstanding = status.remaining.filter((command) => command !== mine);
      if (outstanding.length > 0) {
        await say('Still to run:');
        for (const command of outstanding) await say(`  ${command}`);
      }
      return { status: 'done', detail: `${status.done} of ${status.steps.length} stages done` };
    },
  };
}

/**
 * The refusal a NON-person surface gets for a `humanOnly` step. It names the stage, the reason
 * and the command — so the reader learns why and knows what to do — and it is an Error because
 * every surface's contract is that it reports a refusal rather than quietly doing nothing.
 *
 * A person in their own terminal never sees this: `postbote setup --only terms` is the human
 * doing the human act, which is exactly what the flag is for. The refusal is for a surface that
 * is not them.
 */
export function humanOnlyRefusal(step: SetupStep): Error {
  return new Error(
    `\`${step.name}\` is a step only the account holder can take: the provisioning payload is the ` +
      `secret that binds their account to this machine, and accepting a third party's terms is an ` +
      `act in their name. It has to be run by them, in a terminal: \`${step.command}\``,
  );
}

/**
 * Every option here is honoured by `runSetup` itself. There is deliberately no `dryRun`: it was
 * declared once and no step ever read it, so it guaranteed nothing while promising "this will not
 * write" — a caller passing it got a stage that wrote anyway, and a type that said otherwise. A
 * step that cannot write nothing has no business advertising that it can. A surface that wants a
 * dry run decides so ITSELF, before the core is involved: that is what the MCP `setup_run` tool
 * does, by not running the stage at all.
 */
export interface SetupRunOptions {
  /** Run only these stages, by name; the default is all of them, in order. */
  only?: readonly string[];
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
  /** What is still outstanding after this run, by name. */
  readonly remaining: readonly string[];
  /** The stages that ran but failed, by name. */
  readonly failed: readonly string[];
}

/** The facts a readiness check establishes, kept apart from a stage's outcome so a read-only
 * surface can report them without running anything. */
export interface SetupReadiness {
  mode: SetupMode;
  /** Absolute path of the checkout, or null for a published install. */
  checkout: string | null;
  /** Absolute path of the bundle this process came out of, or null. */
  bundle: string | null;
  /** Absolute path of `gjsify`, or null. Only a checkout needs it. */
  gjsify: string | null;
  /** The config file this run would work on. */
  configPath: string;
  /** Whether the config file is there yet. */
  configExists: boolean;
  /** Backends whose terms are accepted and which are enabled. */
  enabled: string[];
}

export interface SetupStatus {
  readonly readiness: SetupReadiness;
  readonly steps: {
    name: string;
    title: string;
    command: string;
    humanOnly: boolean;
    state: SetupStepState;
    /** Why it reads that way — 'probe', 'this run', or 'no probe'. */
    source: 'probe' | 'run' | 'unknown';
    /** What the step learned that `state` cannot say. Absent when there is nothing to report. */
    warning?: string;
  }[];
  readonly done: number;
  /** How many steps carry a warning. Counted, not just listed: a warning you only see when you
   * already went looking is not a warning. */
  readonly warnings: number;
  /** The `command` of every stage that is not done, in order — what is left, as invocations. */
  readonly remaining: string[];
}

export function setupReadiness(ctx: SetupContext): SetupReadiness {
  return {
    mode: ctx.mode,
    checkout: ctx.checkout,
    bundle: ctx.host.bundlePath(),
    gjsify: ctx.mode === 'checkout' ? ctx.host.which('gjsify') : null,
    configPath: ctx.configPath,
    configExists: ctx.host.exists(ctx.configPath),
    enabled: enabledBackends(ctx.configPath),
  };
}

/**
 * What is left to do, without doing anything.
 *
 * This is the one question a read-only surface can afford to answer, so it gets a real
 * implementation here rather than being derived from a run that has not happened: each step's
 * `probe` reads the machine, and only a step without a probe falls back to what this run
 * recorded. Nothing here mutates, and nothing here can fail: a probe that throws reads as
 * `remaining`, because "I could not tell" must not be reported as "broken".
 */
export async function setupStatus(
  ctx: SetupContext,
  steps: readonly SetupStep[] = SETUP_STEPS,
): Promise<SetupStatus> {
  const rows: SetupStatus['steps'] = [];
  for (const step of steps) {
    let state: SetupStepState = 'remaining';
    let source: SetupStatus['steps'][number]['source'] = 'unknown';
    let warning: string | undefined;
    const recorded = ctx.done.get(step.name);
    if (recorded !== undefined) {
      state = recorded.status === 'done' ? 'done' : recorded.status === 'skipped' ? 'skipped' : 'remaining';
      source = 'run';
      warning = recorded.warning;
    } else if (step.probe !== undefined) {
      try {
        const probe = await step.probe(ctx);
        // A bare state is a valid answer; an object carries the finding next to it. Normalised
        // HERE so every step, old or new, writes one shape.
        state = typeof probe === 'string' ? probe : probe.state;
        warning = typeof probe === 'string' ? undefined : probe.warning;
        source = 'probe';
      } catch {
        state = 'remaining';
        source = 'probe';
      }
    }
    const row: SetupStatus['steps'][number] = {
      name: step.name,
      title: step.title,
      command: step.command,
      humanOnly: step.humanOnly === true,
      state,
      source,
    };
    // Absent rather than `undefined` when there is nothing to report, so a consumer can test for
    // the warning's PRESENCE — and a surface that forgets to pass it on shows no warning at all,
    // which is the failure this whole mechanism exists to make visible.
    if (warning !== undefined) row.warning = warning;
    rows.push(row);
  }
  return {
    readiness: setupReadiness(ctx),
    steps: rows,
    done: rows.filter((s) => s.state === 'done').length,
    warnings: rows.filter((s) => s.warning !== undefined).length,
    remaining: rows.filter((s) => s.state !== 'done').map((s) => s.command),
  };
}

/** Names of the backends the config has enabled with their terms accepted. Manifest-level, so
 * this is a config-file read: no backend is constructed and no gi:// is touched. */
function enabledBackends(path: string): string[] {
  try {
    return backendsList(path)
      .backends.filter((b) => b.enabled)
      .map((b) => b.name);
  } catch {
    return [];
  }
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
  if (wanted !== null) {
    const unknown = [...wanted].filter((name) => !SETUP_STEPS.some((step) => step.name === name));
    if (unknown.length > 0) {
      throw new Error(
        `unknown setup stage${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} — ` +
          `one of ${SETUP_STEPS.map((s) => s.name).join(', ')}`,
      );
    }
  }
  const steps: SetupRunResult['steps'][number][] = [];
  const failed: string[] = [];
  const remaining: string[] = [];
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
    // The ONE renderer of a warning, for every surface: a step no longer prints its own findings
    // through the prompter, because a word that only reaches the interactive stream is a fact the
    // status surfaces lose — which is exactly how a machine with no session bus came to be
    // reported as `done` and saying nothing else.
    if (outcome.warning !== undefined) await ctx.prompter.notify(`  ⚠ ${outcome.warning}`);
    // The reason belongs here for the warning's reason and no weaker: a stage that died without
    // saying why is indistinguishable from a stage the person declined, and that difference is
    // exactly what they need. In the value either way — `setup_status` still reports it — but a
    // value nobody is shown has not reached the person.
    // Narrowing, not casting: `done` carries no reason, so the union says so itself.
    if (outcome.status !== 'done') {
      await ctx.prompter.notify(`  ${outcome.status === 'failed' ? '✗' : '·'} ${outcome.reason}`);
    }
    if (outcome.status === 'done') continue;
    if (outcome.status === 'failed') {
      ok = false;
      failed.push(step.name);
    }
    // A stage that did not finish — declined, not run, or not implemented yet — is outstanding.
    // `remaining` carries the invocation, because that is what a person needs next.
    remaining.push(SETUP_STEPS.find((s) => s.name === step.name)?.command ?? step.name);
    // `bail` means "stop at the first stage that did not finish". The `done` case continued above,
    // so this stage did not finish — `skipped` being the ordinary way to decline. Breaking only on
    // `failed` asked the next question anyway, which is what the flag says it does not do.
    if (options.bail) break;
  }
  return { steps, ok, followUps: SETUP_FOLLOW_UPS, remaining, failed };
}

/**
 * Which postbote this run sets up, and where it lives.
 *
 * A checkout runs the built bundle out of its own tree, because the native addon's absolute
 * prebuild path is baked in at build time and a copied tree starts and then dies at the first
 * Signal command (AGENTS.md). A published install has no tree and just runs the command. The
 * walk starts at the working directory and stops at the first checkout above it.
 */
export function detectSetup(host: CommandRunner): { mode: SetupMode; checkout: string | null } {
  let dir = host.cwd();
  for (let i = 0; i < 8; i++) {
    if (host.isCheckout(dir)) return { mode: 'checkout', checkout: dir };
    const up = dir.slice(0, dir.lastIndexOf('/'));
    if (up === '' || up === dir) break;
    dir = up;
  }
  if (host.which('postbote') !== null) return { mode: 'published', checkout: null };
  throw new Error(
    'neither a postbote checkout above this directory nor a `postbote` command on PATH. ' +
      'Clone the repo and run `gjsify install`, or install the published command, then run this again.',
  );
}

/** The default linker: the existing action, with the SHARED prompter. This is the whole reason
 * `setup` never has to know what a QR looks like. */
export const defaultLink = async (backend: string, prompter: SetupPrompter): Promise<void> => {
  await accountsAdd(backend, prompter);
};

/** The account count for a backend, through the seam when a caller supplied one. */
export function linkedCount(ctx: SetupContext, backend: string): Promise<number> {
  return ctx.countAccounts === undefined ? defaultCountAccounts(ctx, backend) : ctx.countAccounts(backend);
}
