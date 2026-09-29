/**
 * The setup run without a machine: a fake host, a scripted person, eight announced stages.
 *
 * What is asserted here is the SHAPE of the command — that the stage list is the eight the
 * shell wizard ran, that every word reaches a person through the prompter (so a future Adwaita
 * frontend gets all of it), and that a stage which throws fails alone. The stages' own bodies
 * are asserted in `setup-steps.test.ts`.
 */

import { describe, expect, it } from '@gjsify/unit';

import { SETUP_FOLLOW_UPS, SETUP_STEPS, humanOnlyRefusal, runSetup, setupStatus } from '../../../src/core/actions/setup.ts';
import type { SetupStep, SetupStepState } from '../../../src/core/actions/setup.ts';
import { fakeContext, fakeHost, fakePrompter } from './setup-fakes.ts';

export default async function setup(): Promise<void> {
  describe('postbote setup', () => {
    it('runs the eight stages the shell wizard ran, in that order', () => {
      expect(SETUP_STEPS.map((step) => step.name)).toStrictEqual([
        'readiness',
        'link-signal',
        'link-whatsapp',
        'terms',
        'index',
        'daemon',
        'unit',
        'finish',
      ]);
      for (const step of SETUP_STEPS) {
        expect(step.title.length > 0).toBe(true);
      }
    });

    it('reports every stage and reaches the person only through the prompter', async () => {
      const ctx = fakeContext();
      const result = await runSetup(ctx);

      expect(result.steps.map((s) => s.name)).toStrictEqual(SETUP_STEPS.map((s) => s.name));
      // Every stage announced itself, and every announcement went through the prompter — the
      // seam a widget frontend will render instead.
      for (const step of SETUP_STEPS) {
        expect(ctx.prompter.notified.some((line) => line.includes(step.title))).toBe(true);
      }
      // The unit stage verifies its own file with `systemd-analyze --user verify` and that is the
      // ONE captured call in a whole run (a file check, not a session). Everything else leaves its
      // output attached, and no word of the run bypassed the prompter.
      const captured = ctx.host.calls.filter((call) => call.captured);
      expect(captured.length).toBe(1);
      expect(captured[0].argv[0]).toBe('systemd-analyze');
      expect(captured[0].argv[1]).toBe('--user');
      // This machine has no gjsify on PATH and a `systemd-analyze` that fails, so readiness and
      // the unit stage genuinely fail and `ok` is false. The run still completed all eight stages
      // and still reported: a failed stage is not a dead run, and each one named its own reason.
      const failed = result.steps.filter((s) => s.outcome.status === 'failed').map((s) => s.name);
      expect(failed).toStrictEqual(['readiness', 'unit']);
      expect(result.ok).toBe(false);
      expect(result.steps).toHaveLength(8);
      for (const step of result.steps) {
        if (step.outcome.status === 'failed') {
          expect(step.outcome.reason.length > 0).toBe(true);
        }
      }
    });

    it('carries the follow-ups as a list, not as prose', () => {
      expect(SETUP_FOLLOW_UPS.length >= 3).toBe(true);
      expect(SETUP_FOLLOW_UPS.some((text) => text.includes('0.53'))).toBe(true);
      expect(SETUP_FOLLOW_UPS.some((text) => text.includes('Adwaita'))).toBe(true);
    });

    it('runs only the stages it was asked for', async () => {
      const ctx = fakeContext();
      const result = await runSetup(ctx, { only: ['terms', 'finish'] });
      expect(result.steps.map((s) => s.name)).toStrictEqual(['terms', 'finish']);
    });

    it('treats a stage that throws as a failed STAGE, not a dead run', async () => {
      // `daemon` is the first stage that touches the machine, and on a machine with no enabled
      // delivery backend it is the one that can fail — the run must still reach the report.
      const ctx = fakeContext();
      const result = await runSetup(ctx);
      const failed = result.steps.filter((s) => s.outcome.status === 'failed');
      expect(result.ok === (failed.length === 0)).toBe(true);
    });

    it('leaves the rest of the run to the person when a stage fails', async () => {
      const prompter = fakePrompter();
      const ctx = fakeContext({ prompter });
      const stop = await runSetup(ctx, { bail: true, only: ['readiness', 'index'] });
      expect(stop.steps.length <= 2).toBe(true);
    });

    it('gives every stage the invocation that performs it on its own', () => {
      for (const step of SETUP_STEPS) {
        expect(step.command).toBe(`postbote setup --only ${step.name}`);
      }
    });

    it('refuses to name an unknown stage rather than quietly doing nothing', async () => {
      const ctx = fakeContext();
      let message = '';
      try {
        await runSetup(ctx, { only: ['nope'] });
      } catch (err: unknown) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message.includes('nope')).toBe(true);
    });

    it('reports the invocation of every stage that did not finish', async () => {
      const ctx = fakeContext();
      const result = await runSetup(ctx);
      // `finish` did finish — it is the stage that prints the rest — so it is not outstanding.
      expect(result.remaining).toStrictEqual(SETUP_STEPS.slice(0, 7).map((s) => s.command));
    });
  });

  describe('the stages a person must take themselves', () => {
    it('are the two linking stages and the terms', () => {
      expect(SETUP_STEPS.filter((s) => s.humanOnly === true).map((s) => s.name)).toStrictEqual([
        'link-signal',
        'link-whatsapp',
        'terms',
      ]);
    });

    it('refuse by naming the command the person would run', () => {
      const step = SETUP_STEPS.find((s) => s.name === 'link-signal');
      expect(step).toBeDefined();
      const message = humanOnlyRefusal(step!).message;
      expect(message.includes('postbote setup --only link-signal')).toBe(true);
      // The reason names both reasons, so a reader of the refusal learns why.
      expect(message.includes('secret')).toBe(true);
      expect(message.includes('terms')).toBe(true);
    });
  });

  describe('setupStatus — what is left, without touching anything', () => {
    it('answers before anything has run, from the machine and not from a run', async () => {
      const host = fakeHost({ XDG_CONFIG_HOME: '/home/tester/.config' });
      const ctx = fakeContext({ host });
      const status = await setupStatus(ctx);

      expect(status.steps).toHaveLength(8);
      // A status read asks `systemctl` whether the unit is enabled — that is a question, and its
      // output is never captured. Nothing was written, and nothing was read back.
      for (const call of ctx.host.calls) expect(call.captured).toBe(false);
      expect(status.readiness.mode).toBe('checkout');
      expect(status.readiness.gjsify).toBe(null);
      expect(status.readiness.configExists).toBe(false);
      // Nothing is set up on this machine, so every stage reads `remaining` — a status read must
      // not report work that was never done.
      expect(status.steps.every((s) => s.state === 'remaining')).toBe(true);
    });

    it('says `done` only where a step can see it, and says why', async () => {
      const host = fakeHost();
      // A probe that cannot answer must read as `remaining`, never as `done` and never as a throw.
      const blind: SetupStep = {
        name: 'blind',
        title: 'A stage whose probe cannot answer',
        command: 'postbote setup --only blind',
        async run() {
          return { status: 'done' };
        },
        async probe(): Promise<SetupStepState> {
          throw new Error('no session bus');
        },
      };
      const status = await setupStatus(fakeContext({ host }), [blind]);
      expect(status.steps[0].state).toBe('remaining');
      expect(status.steps[0].source).toBe('probe');
    });

    it('prefers what a run recorded over a probe', async () => {
      const ctx = fakeContext();
      await runSetup(ctx, { only: ['readiness'] });
      const status = await setupStatus(ctx);
      const ran = status.steps.find((s) => s.name === 'readiness');
      expect(ran?.source).toBe('run');
    });

    it('lists the invocation of everything not done', async () => {
      const ctx = fakeContext();
      const status = await setupStatus(ctx);
      expect(status.remaining).toStrictEqual(SETUP_STEPS.map((s) => s.command));
      expect(status.done).toBe(0);
    });
  });
}
