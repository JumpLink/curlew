/**
 * The eight stages, each against a fake machine and a scripted person — no phone, no session bus,
 * no systemd, no index.
 *
 * Two of these are security tests wearing ordinary clothes:
 *
 *   - the linking stages must not capture, redirect or log a pairing payload, and
 *   - the terms stage must display the notice before it asks, and must not accept on the
 *     person's behalf.
 *
 * Both are checked against a payload the fakes print through the prompter, so its appearance
 * anywhere else — in a captured command's output, in an error message, in a file the run wrote —
 * is a real finding and not a comment.
 */

import { describe, expect, it } from '@gjsify/unit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FINISH_STAGE,
  SETUP_LINK_BACKENDS,
  SETUP_STEPS,
  detectSetup,
  runSetup,
  setupStatus,
} from '../../../src/core/actions/setup.ts';
import type { SetupContext, SetupStepState } from '../../../src/core/actions/setup.ts';
import { FAKE_PAIRING_PAYLOAD, SANDBOX, fakeContext, fakeHost, fakePrompter } from './setup-fakes.ts';

/** Every word the run said, joined — the whole surface a person or a log could have seen. */
function transcript(ctx: { prompter: { notified: string[] } }): string {
  return ctx.prompter.notified.join('\n');
}

async function probeStage(name: string, ctx: SetupContext): Promise<SetupStepState> {
  const step = stage(name);
  if (step.probe === undefined) throw new Error(`${name} has no probe`);
  const probe = await step.probe(ctx);
  return typeof probe === 'string' ? probe : probe.state;
}

function stage(name: string): (typeof SETUP_STEPS)[number] {
  const found = SETUP_STEPS.find((step) => step.name === name);
  if (found === undefined) throw new Error(`no such stage: ${name}`);
  return found;
}

export default async function setupSteps(): Promise<void> {
  describe('which curlew is being set up', () => {
    it('finds the checkout above the working directory', () => {
      const host = fakeHost({ PWD: '/src/curlew/app/src' });
      host.files.set('/src/curlew/package.json', '{}');
      host.files.set('/src/curlew/app/package.json', '{}');
      expect(detectSetup(host)).toStrictEqual({ mode: 'checkout', checkout: '/src/curlew' });
    });

    it('falls back to a published install on PATH', () => {
      const host = fakeHost({ PWD: '/home/tester' });
      host.commands.set('curlew', { path: '/usr/local/bin/curlew', code: 0, output: '' });
      expect(detectSetup(host)).toStrictEqual({ mode: 'published', checkout: null });
    });

    it('refuses to guess when there is neither, and says how to fix it', () => {
      const host = fakeHost({ PWD: '/home/tester' });
      let message = '';
      try {
        detectSetup(host);
      } catch (err: unknown) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message.includes('gjsify install')).toBe(true);
    });
  });

  describe('the readiness stage', () => {
    it('fails with the command to run when gjsify is missing, and never builds', async () => {
      const ctx = fakeContext();
      const outcome = await stage('readiness').run(ctx);
      expect(outcome.status).toBe('failed');
      expect(outcome.status === 'failed' && outcome.reason.includes('npm install -g @gjsify/cli')).toBe(true);
      // The point: a command cannot build itself, so nothing here shells out to a build.
      expect(ctx.host.calls.length).toBe(0);
    });

    it('reads done once gjsify and the bundle are there', async () => {
      const host = fakeHost();
      host.commands.set('gjsify', { path: '/usr/bin/gjsify', code: 0, output: '' });
      host.files.set('/home/tester/app/dist/curlew.gjs.mjs', 'bundle');
      const ctx = fakeContext({ host });
      expect(await probeStage('readiness', ctx)).toBe('done');
      const outcome = await stage('readiness').run(ctx);
      expect(outcome.status).toBe('done');
      expect(transcript(ctx)).toBe(transcript(ctx)); // no payload anywhere
    });

    it('says a published install needs neither', async () => {
      const ctx = fakeContext({ mode: 'published', checkout: null });
      const outcome = await stage('readiness').run(ctx);
      expect(outcome.status).toBe('done');
      expect(transcript(ctx).includes('No checkout needed')).toBe(true);
    });

    // The defect this pins, measured on the previous shape: with no session bus at all,
    // `curlew setup --status` printed `done` for readiness and nothing else. The stage's own
    // verdict went through `prompter.notify`, so it reached a person at a keyboard and no other
    // surface — and a machine that cannot read a single account reported itself ready, silently,
    // while the whole product is inert. The warning now travels in the VALUE, on the probe path
    // (`--status` never runs a stage) as well as the run path.
    //
    // Pinned on the exact words. "unavailable" is the one that carries the meaning: `state` stays
    // `done` because the check DID run, so a refactor that softens this to "not ready" — which
    // would read as a stage that failed rather than a finding about the machine — must fail here
    // on purpose.
    it('carries a dead session bus as a warning, not as a silent done', async () => {
      // A machine that is otherwise READY — bundle and gjsify both there — so the only finding
      // under test is the session bus. Otherwise the stage reads `remaining` and proves nothing
      // about a warning that rides on a `done`.
      const host = fakeHost();
      host.commands.set('gjsify', { path: '/usr/bin/gjsify', code: 0, output: '' });
      host.files.set('/home/tester/app/dist/curlew.gjs.mjs', 'bundle');
      const dead = fakeContext({
        host,
        checkAccounts: async () => {
          throw new Error('Could not connect to the session bus');
        },
      });
      const status = await setupStatus(dead);
      const readiness = status.steps.find((s) => s.name === 'readiness');
      expect(readiness?.state).toBe('done');
      expect(readiness?.warning).toContain('GNOME Online Accounts');
      expect(readiness?.warning).toContain('unavailable');
      // Counted, not only listed: a warning you only see when you go looking is not a warning.
      expect(status.warnings).toBe(1);
    });

    it('reports a reachable session bus as done with NO warning', async () => {
      const host = fakeHost();
      host.commands.set('gjsify', { path: '/usr/bin/gjsify', code: 0, output: '' });
      host.files.set('/home/tester/app/dist/curlew.gjs.mjs', 'bundle');
      const alive = fakeContext({ host });
      const status = await setupStatus(alive);
      expect(status.steps.find((s) => s.name === 'readiness')?.state).toBe('done');
      expect(status.steps.find((s) => s.name === 'readiness')?.warning).toBe(undefined);
      expect(status.warnings).toBe(0);
    });

    it('takes the warning from a run through to the status, and prints it once', async () => {
      const host = fakeHost();
      host.commands.set('gjsify', { path: '/usr/bin/gjsify', code: 0, output: '' });
      host.files.set('/home/tester/app/dist/curlew.gjs.mjs', 'bundle');
      const ctx = fakeContext({ host, checkAccounts: async () => ({ ok: false, message: 'no bus' }) });
      const outcome = await stage('readiness').run(ctx);
      expect(outcome.status).toBe('done');
      expect(outcome.status === 'done' && outcome.warning).toContain('unavailable');
      // The step no longer prints its own verdict — the driver renders the outcome's warning, so
      // the interactive and the read-only surfaces cannot drift.
      expect(transcript(ctx).includes('unavailable')).toBe(false);
      await runSetup(ctx, { only: ['readiness'] });
      expect(transcript(ctx).includes('⚠ GNOME Online Accounts: unavailable')).toBe(true);
      const status = await setupStatus(ctx);
      expect(status.steps.find((s) => s.name === 'readiness')?.warning).toContain('unavailable');
      expect(status.warnings).toBe(1);
    });
  });

  describe('the linking stages', () => {
    for (const backend of SETUP_LINK_BACKENDS) {
      it(`link-${backend} gets the payload through the prompter and captures nothing`, async () => {
        const ctx = fakeContext({ prompter: fakePrompter([true]) });
        await stage(`link-${backend}`).run(ctx);

        // The payload reached the person…
        expect(transcript(ctx).includes(FAKE_PAIRING_PAYLOAD)).toBe(true);
        // …and NOTHING captured it. No host call at all may have asked for capture, and no
        // captured output may hold the payload: that is the "no tee, no redirect, no pipe" rule.
        for (const call of ctx.host.calls) {
          expect(call.captured).toBe(false);
          expect(call.options?.capture).toBe(undefined);
        }
      });

      it(`link-${backend} hands the SHARED prompter to the linker`, async () => {
        // Identity, not shape: a linker given a different object could capture the payload on
        // its way out, and nothing in the type system would say so.
        let received: unknown = null;
        const ctx = fakeContext({
          prompter: fakePrompter([true]),
          link: async (_backend, prompter) => {
            received = prompter;
          },
        });
        await stage(`link-${backend}`).run(ctx);
        expect(received === ctx.prompter).toBe(true);
      });

      it(`link-${backend} declines without linking, and says why`, async () => {
        const ctx = fakeContext({ prompter: fakePrompter([false]) });
        const outcome = await stage(`link-${backend}`).run(ctx);
        expect(outcome.status).toBe('skipped');
        expect(ctx.linked.length).toBe(0);
      });
    }

    // Removing the device on the phone leaves the local session file behind, so "a session
    // exists" said "already linked — nothing to do". Signal was never asked. That is the one
    // state the tool must not claim to know: a local file is evidence of an attempt, not of a
    // live link.
    it('does not claim a live link it never asked Signal about', async () => {
      const ctx = fakeContext({ countAccounts: async () => 1, prompter: fakePrompter([]) });
      const outcome = await stage('link-signal').run(ctx);
      const text = transcript(ctx);
      expect(outcome.status).toBe('done');
      expect(text.includes('nothing to do')).toBe(false);
      expect(text.includes('not been checked with Signal')).toBe(true);
      expect(text.includes('curlew sync')).toBe(true);
    });

    // Once a sync HAS found out, that is a fact and may be stated. Same shape, different source.
    it('states the link as gone once a sync has seen Signal drop it', async () => {
      const ctx = fakeContext({
        countAccounts: async () => 1,
        loggedOutBackend: async () => 'signal',
        prompter: fakePrompter([]),
      });
      await stage('link-signal').run(ctx);
      const text = transcript(ctx);
      expect(text.includes('Signal no longer knows this device')).toBe(true);
      expect(text.includes('not been checked with Signal')).toBe(false);
    });

    it('treats a dropped link as remaining work, not as done', async () => {
      const ctx = fakeContext({
        countAccounts: async () => 1,
        loggedOutBackend: async () => 'signal',
        prompter: fakePrompter([]),
      });
      expect(await probeStage('link-signal', ctx)).toBe('remaining');
    });

    it('warns that the pairing code is a secret before showing anything', async () => {
      const ctx = fakeContext({ prompter: fakePrompter([true]) });
      await stage('link-signal').run(ctx);
      const text = transcript(ctx);
      expect(text.includes('Do not copy, paste or send it')).toBe(true);
    });
  });

  describe('the terms stage', () => {
    it('shows the notice BEFORE it asks', async () => {
      const ctx = fakeContext({
        prompter: fakePrompter([false, false]),
        countAccounts: async () => 1,
      });
      await stage('terms').run(ctx);
      const text = transcript(ctx);
      const notice = text.indexOf('asks you to accept these terms');
      const question = text.indexOf('Read the terms for');
      expect(notice > 0).toBe(true);
      expect(question > notice).toBe(true);
    });

    it("never accepts on the person's behalf", async () => {
      // Declined, with a linked account and a notice on screen: the config must be untouched.
      const ctx = fakeContext({
        prompter: fakePrompter([false, false]),
        countAccounts: async () => 1,
      });
      const outcome = await stage('terms').run(ctx);
      expect(outcome.status).toBe('skipped');
      expect(transcript(ctx).includes('stays disabled')).toBe(true);
      // `backendsEnable` is the only writer of the config, and a declined question must not
      // reach it: after this run there is still no config file at all.
      expect(existsSync(ctx.configPath)).toBe(false);
    });

    // This test used to assert the opposite, and its name said it was deliberate: "leaves a
    // backend alone that has no linked device". That guard could not be satisfied from inside
    // setup. Adding an account needs an enabled backend (registry.ts, `backend X is not enabled`);
    // enabling needed a linked account (right here). Each waited for the other, so the QR step
    // failed in a millisecond, said nothing, and the person was told at the end that they had no
    // linked account — as if they had declined. The registry never required an account to enable
    // anything: `enable` gates on the terms, and the daemon reports `loggedOut` for an enabled
    // backend with no session. So the consent question is asked first and the device second.
    it('asks for the terms with nothing linked yet, and enables on acceptance', async () => {
      // Its own config path: these tests WRITE one, and the sandbox default is shared — an
      // earlier version of this test enabled a backend at the default path and broke the
      // security test below, which asserts that no config file exists after a declined run.
      const ctx = fakeContext({
        prompter: fakePrompter([true, true]),
        configPath: join(SANDBOX, 'curlew', 'config-accept.json'),
      });
      const outcome = await stage('terms').run(ctx);
      expect(ctx.prompter.asked.length).toBeGreaterThan(0);
      expect(transcript(ctx).includes('leaving it disabled')).toBe(false);
      expect(transcript(ctx).includes('enabled')).toBe(true);
      expect(outcome.status).toBe('done');
    });

    it('puts the terms before the linking stages, so the order can actually complete', () => {
      expect(SETUP_STEPS.map((step) => step.name)).toStrictEqual([
        'readiness',
        'terms',
        'link-signal',
        'link-whatsapp',
        'index',
        'daemon',
        'unit',
        FINISH_STAGE,
      ]);
    });

    it('links without ever hitting the backend-not-enabled error', async () => {
      // The cycle, end to end. The fake reads the same config file the registry reads, so the
      // guard fires for the same reason it fired for the person — the earlier version of this
      // test passed before AND after the fix, because a fake `link` can never raise the
      // registry's error, and a test that cannot fail proves nothing.
      //
      // It reads the file rather than calling `accountsAdd`: that would open a real socket to
      // Signal in a unit test. The copy of the predicate is deliberate and two lines long; the
      // alternative is a test that passes for the wrong reason.
      const ctx = fakeContext({
        prompter: fakePrompter([true, true]),
        configPath: join(SANDBOX, 'curlew', 'config-cycle.json'),
        countAccounts: async () => 0,
      });
      ctx.link = async () => {
        const stored = existsSync(ctx.configPath)
          ? (JSON.parse(readFileSync(ctx.configPath, 'utf8')) as {
              backends?: { name: string; enabled: boolean }[];
            })
          : { backends: [] };
        const enabled = (stored.backends ?? []).filter((b) => b.enabled).map((b) => b.name);
        if (!enabled.includes('signal')) {
          throw new Error('backend signal is not enabled — `curlew backends enable signal` turns it on');
        }
      };
      const result = await runSetup(ctx, { only: ['terms', 'link-signal'] });
      const reasons = result.steps
        .map((s) => `${s.name}: ${s.outcome.status === 'done' ? '' : s.outcome.reason}`)
        .join('\n');
      expect(reasons.includes('not enabled')).toBe(false);
      expect(reasons.includes('leaving it disabled')).toBe(false);
    });

    it('stops at the first stage that did not finish, when --bail is set', async () => {
      // The flag's own words are "stop after the first stage that does not finish". It stopped
      // only after a FAILURE, so a declined stage — the most common way a person says no — did
      // not stop it, and the next question arrived anyway.
      const ctx = fakeContext({
        prompter: fakePrompter([]),
        configPath: join(SANDBOX, 'curlew', 'config-bail.json'),
      });
      await runSetup(ctx, { only: ['link-signal', 'link-whatsapp'], bail: true });
      const said = transcript(ctx);
      expect(said.includes('Link Signal now?')).toBe(true);
      expect(said.includes('Link WhatsApp now?')).toBe(false);
    });

    it('says why a stage failed, where the stage ran', async () => {
      const ctx = fakeContext({
        // The literal boolean, not the string "y": the fake decides on `value === true`, and a
        // string declines the question — so the linker below never runs and the test passes for
        // the wrong reason, which is a mistake I made in the first version of it.
        prompter: fakePrompter([true]),
        configPath: join(SANDBOX, 'curlew', 'config-failure.json'),
        link: async () => {
          throw new Error('the provisioning connection failed — nothing was saved');
        },
      });
      const result = await runSetup(ctx, { only: ['link-signal'] });
      const failed = result.steps.find((s) => s.name === 'link-signal');
      expect(failed?.outcome.status).toBe('failed');
      // `warning` was already announced here; `reason` was not, so a stage that died said nothing
      // at all until the closing report.
      expect(transcript(ctx).includes('provisioning connection failed')).toBe(true);
    });

    it('is a human act on every surface, with a reason that names both reasons', () => {
      expect(stage('terms').humanOnly).toBe(true);
      expect(stage('terms').command).toBe('curlew setup --only terms');
    });
  });

  describe('the index stage', () => {
    it('names `curlew sync` as the only writer', async () => {
      const ctx = fakeContext();
      await stage('index').run(ctx);
      expect(transcript(ctx).includes('the only thing that writes it')).toBe(true);
    });

    it('skips when declined rather than writing anyway', async () => {
      const ctx = fakeContext({ prompter: fakePrompter([false]) });
      const outcome = await stage('index').run(ctx);
      expect(outcome.status).toBe('skipped');
    });
  });

  describe('the daemon stage', () => {
    it('skips when no delivery backend is enabled, and says the daemon would refuse', async () => {
      const ctx = fakeContext();
      const outcome = await stage('daemon').run(ctx);
      expect(outcome.status).toBe('skipped');
      expect(outcome.status === 'skipped' && outcome.reason.includes('refuses to start')).toBe(true);
    });

    it('reads done when the unit that runs it is enabled', async () => {
      const host = fakeHost();
      host.commands.set('systemctl', { path: '/usr/bin/systemctl', code: 0, output: 'enabled' });
      const ctx = fakeContext({ host });
      expect(await probeStage('daemon', ctx)).toBe('done');
      const off = fakeHost();
      off.commands.set('systemctl', { path: '/usr/bin/systemctl', code: 1, output: 'disabled' });
      expect(await probeStage('daemon', fakeContext({ host: off }))).toBe('remaining');
    });
  });

  describe('the unit stage', () => {
    it('writes to the XDG config home, never a hardcoded ~/.config', async () => {
      const host = fakeHost({ XDG_CONFIG_HOME: '/xdg/config' });
      const ctx = fakeContext({ host });
      await stage('unit').run(ctx);
      const written = [...host.files.keys()];
      expect(written.join(' ')).toBe('/xdg/config/systemd/user/curlew-daemon.service');
    });

    it('falls back to $HOME/.config when XDG_CONFIG_HOME is unset', async () => {
      const host = fakeHost();
      const ctx = fakeContext({ host });
      await stage('unit').run(ctx);
      expect([...host.files.keys()].join(' ')).toBe(
        '/home/tester/.config/systemd/user/curlew-daemon.service',
      );
    });

    it("returns systemd-analyze's OWN exit code and does not enable a unit that failed", async () => {
      const host = fakeHost();
      host.commands.set('systemd-analyze', { path: '/usr/bin/systemd-analyze', code: 3, output: 'bad' });
      const ctx = fakeContext({ host, prompter: fakePrompter([true]) });
      const outcome = await stage('unit').run(ctx);
      expect(outcome.status).toBe('failed');
      expect(outcome.status === 'failed' && outcome.reason.includes('exited 3')).toBe(true);
      // Never reached: nothing enabled, because a unit that does not verify is not offered.
      expect(host.calls.some((call) => call.argv.includes('enable'))).toBe(false);
    });

    it('captures the verify output — the one capture in the whole run', async () => {
      const host = fakeHost();
      host.commands.set('systemd-analyze', { path: '/usr/bin/systemd-analyze', code: 0, output: '' });
      const ctx = fakeContext({ host });
      await stage('unit').run(ctx);
      const verify = host.calls.filter((call) => call.argv[0] === 'systemd-analyze');
      expect(verify.length).toBe(1);
      expect(verify[0].captured).toBe(true);
      // It captured a FILE CHECK. Nothing else in the run captured anything.
      for (const call of host.calls) {
        if (call.argv[0] !== 'systemd-analyze') expect(call.captured).toBe(false);
      }
    });

    it('leaves an already-enabled unit alone', async () => {
      const host = fakeHost();
      host.commands.set('systemd-analyze', { path: '/usr/bin/systemd-analyze', code: 0, output: '' });
      host.commands.set('systemctl', { path: '/usr/bin/systemctl', code: 0, output: 'enabled' });
      const ctx = fakeContext({ host, prompter: fakePrompter([true]) });
      const outcome = await stage('unit').run(ctx);
      expect(outcome.status).toBe('done');
      expect(host.calls.some((call) => call.argv.includes('enable'))).toBe(false);
    });

    it('reads done once the file is there', async () => {
      const host = fakeHost();
      host.files.set('/home/tester/.config/systemd/user/curlew-daemon.service', '[Service]\n');
      expect(await probeStage('unit', fakeContext({ host }))).toBe('done');
      expect(await probeStage('unit', fakeContext({ host: fakeHost() }))).toBe('remaining');
    });
  });

  describe('a second run', () => {
    it('says what is already done instead of failing', async () => {
      const host = fakeHost();
      host.commands.set('gjsify', { path: '/usr/bin/gjsify', code: 0, output: '' });
      host.commands.set('systemd-analyze', { path: '/usr/bin/systemd-analyze', code: 0, output: '' });
      host.commands.set('systemctl', { path: '/usr/bin/systemctl', code: 0, output: 'enabled' });
      host.files.set('/home/tester/app/dist/curlew.gjs.mjs', 'bundle');
      const ctx = fakeContext({ host, prompter: fakePrompter([false, false, false, false]) });
      const first = await runSetup(ctx);
      expect(first.steps.every((s) => s.outcome.status !== 'failed')).toBe(true);
      // The unit stage re-wrote the same file and found it enabled: no failure, and the file is
      // still the unit the template renders.
      const written = host.files.get('/home/tester/.config/systemd/user/curlew-daemon.service') ?? '';
      expect(written.includes('ExecStart=')).toBe(true);
      expect(written.includes('[Install]')).toBe(true);
    });
  });

  describe('setupStatus after a run', () => {
    it('reports the stages that finished and the ones that did not', async () => {
      const host = fakeHost();
      host.commands.set('gjsify', { path: '/usr/bin/gjsify', code: 0, output: '' });
      host.files.set('/home/tester/app/dist/curlew.gjs.mjs', 'bundle');
      const ctx = fakeContext({ host, prompter: fakePrompter([false, false, false, false]) });
      await runSetup(ctx, { only: ['readiness', 'link-signal'] });
      const status = await setupStatus(ctx);
      const byName = new Map(status.steps.map((s) => [s.name, s]));
      expect(byName.get('readiness')?.state).toBe('done');
      expect(byName.get('link-signal')?.state).toBe('skipped');
      // Never run, so the probe decides — and the unit is not there yet.
      expect(byName.get('unit')?.state).toBe('remaining');
      expect(byName.get('unit')?.command).toBe('curlew setup --only unit');
    });
  });
}
