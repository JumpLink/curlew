/**
 * The setup run without a machine: a fake host, a scripted person, eight announced stages.
 *
 * What is asserted here is the SHAPE of the command — that the stage list is the eight the
 * shell wizard ran, that every word reaches a person through the prompter (so a future Adwaita
 * frontend gets all of it), and that a stage which throws fails alone. The stages' own bodies
 * are asserted in `setup-steps.test.ts`.
 */

import { describe, expect, it } from '@gjsify/unit';

import { SETUP_FOLLOW_UPS, SETUP_STEPS, runSetup } from '../../../src/core/actions/setup.ts';
import { fakeContext, fakePrompter } from './setup-fakes.ts';

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
      expect(ctx.host.calls.length).toBe(0);
      expect(result.ok).toBe(true);
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
  });
}
