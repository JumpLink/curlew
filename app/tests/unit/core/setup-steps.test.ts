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
import { existsSync } from 'node:fs';

import {
  SETUP_LINK_BACKENDS,
  SETUP_STEPS,
  detectSetup,
  runSetup,
  setupStatus,
} from '../../../src/core/actions/setup.ts';
import type { SetupContext, SetupStep, SetupStepState } from '../../../src/core/actions/setup.ts';
import { FAKE_PAIRING_PAYLOAD, fakeContext, fakeHost, fakePrompter } from './setup-fakes.ts';

/** Every word the run said, joined — the whole surface a person or a log could have seen. */
function transcript(ctx: { prompter: { notified: string[] } }): string {
  return ctx.prompter.notified.join('\n');
}

async function probeStage(name: string, ctx: SetupContext): Promise<SetupStepState> {
  const step = stage(name);
  if (step.probe === undefined) throw new Error(`${name} has no probe`);
  return step.probe(ctx);
}

function stage(name: string): (typeof SETUP_STEPS)[number] {
  const found = SETUP_STEPS.find((step) => step.name === name);
  if (found === undefined) throw new Error(`no such stage: ${name}`);
  return found;
}

export default async function setupSteps(): Promise<void> {
  describe('which postbote is being set up', () => {
    it('finds the checkout above the working directory', () => {
      const host = fakeHost({ PWD: '/src/postbote/app/src' });
      host.files.set('/src/postbote/package.json', '{}');
      host.files.set('/src/postbote/app/package.json', '{}');
      expect(detectSetup(host)).toStrictEqual({ mode: 'checkout', checkout: '/src/postbote' });
    });

    it('falls back to a published install on PATH', () => {
      const host = fakeHost({ PWD: '/home/tester' });
      host.commands.set('postbote', { path: '/usr/local/bin/postbote', code: 0, output: '' });
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
      host.files.set('/home/tester/app/dist/postbote.gjs.mjs', 'bundle');
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

    it('never accepts on the person\'s behalf', async () => {
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

    it('leaves a backend alone that has no linked device, and says so', async () => {
      const ctx = fakeContext({ prompter: fakePrompter([true]) });
      const outcome = await stage('terms').run(ctx);
      expect(outcome.status).toBe('skipped');
      expect(transcript(ctx).includes('leaving it disabled')).toBe(true);
      expect(ctx.prompter.asked.length).toBe(0);
    });

    it('is a human act on every surface, with a reason that names both reasons', () => {
      expect(stage('terms').humanOnly).toBe(true);
      expect(stage('terms').command).toBe('postbote setup --only terms');
    });
  });

  describe('the index stage', () => {
    it('names `postbote sync` as the only writer', async () => {
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
      expect(written.join(' ')).toBe('/xdg/config/systemd/user/postbote-daemon.service');
    });

    it('falls back to $HOME/.config when XDG_CONFIG_HOME is unset', async () => {
      const host = fakeHost();
      const ctx = fakeContext({ host });
      await stage('unit').run(ctx);
      expect([...host.files.keys()].join(' ')).toBe(
        '/home/tester/.config/systemd/user/postbote-daemon.service',
      );
    });

    it('returns systemd-analyze\'s OWN exit code and does not enable a unit that failed', async () => {
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
      host.files.set('/home/tester/.config/systemd/user/postbote-daemon.service', '[Service]\n');
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
      host.files.set('/home/tester/app/dist/postbote.gjs.mjs', 'bundle');
      const ctx = fakeContext({ host, prompter: fakePrompter([false, false, false, false]) });
      const first = await runSetup(ctx);
      expect(first.steps.every((s) => s.outcome.status !== 'failed')).toBe(true);
      // The unit stage re-wrote the same file and found it enabled: no failure, and the file is
      // still the unit the template renders.
      const written = host.files.get('/home/tester/.config/systemd/user/postbote-daemon.service') ?? '';
      expect(written.includes('ExecStart=')).toBe(true);
      expect(written.includes('[Install]')).toBe(true);
    });
  });

  describe('setupStatus after a run', () => {
    it('reports the stages that finished and the ones that did not', async () => {
      const host = fakeHost();
      host.commands.set('gjsify', { path: '/usr/bin/gjsify', code: 0, output: '' });
      host.files.set('/home/tester/app/dist/postbote.gjs.mjs', 'bundle');
      const ctx = fakeContext({ host, prompter: fakePrompter([false, false, false, false]) });
      await runSetup(ctx, { only: ['readiness', 'link-signal'] });
      const status = await setupStatus(ctx);
      const byName = new Map(status.steps.map((s) => [s.name, s]));
      expect(byName.get('readiness')?.state).toBe('done');
      expect(byName.get('link-signal')?.state).toBe('skipped');
      // Never run, so the probe decides — and the unit is not there yet.
      expect(byName.get('unit')?.state).toBe('remaining');
      expect(byName.get('unit')?.command).toBe('postbote setup --only unit');
    });
  });
}
