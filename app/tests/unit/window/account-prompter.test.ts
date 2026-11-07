import { describe, expect, it } from '@gjsify/unit';

import {
  createSurfacePrompter,
  PromptCancelled,
  type PromptStep,
} from '../../../src/window/account-prompter.ts';

function recorder() {
  const steps: PromptStep[] = [];
  return { steps, surface: { present: (step: PromptStep) => void steps.push(step) } };
}

export default async () => {
  await describe('the window prompter', async () => {
    await it('shows a question and resolves with the answer', async () => {
      const { steps, surface } = recorder();
      const prompter = createSurfacePrompter(surface);
      const answer = prompter.ask('Password', { secret: true });
      const step = steps[0];
      expect(step.kind).toBe('ask');
      if (step.kind !== 'ask') return;
      expect(step.label).toBe('Password');
      expect(step.secret).toBe(true);
      step.submit('hunter2');
      expect(await answer).toBe('hunter2');
    });

    await it('treats a question as not secret unless asked to', async () => {
      const { steps, surface } = recorder();
      void createSurfacePrompter(surface).ask('Name');
      const step = steps[0];
      expect(step.kind === 'ask' && step.secret).toBe(false);
    });

    await it('answers a question only once', async () => {
      const { steps, surface } = recorder();
      const prompter = createSurfacePrompter(surface);
      const answer = prompter.ask('Code');
      const step = steps[0];
      if (step.kind !== 'ask') throw new Error('expected a question');
      step.submit('first');
      step.submit('second');
      expect(await answer).toBe('first');
    });

    await it('shows status and QR steps', async () => {
      const { steps, surface } = recorder();
      const prompter = createSurfacePrompter(surface);
      prompter.notify('Connecting');
      prompter.showQr?.('payload', 'Scan it');
      expect(steps).toStrictEqual([
        { kind: 'status', message: 'Connecting' },
        { kind: 'qr', data: 'payload', instructions: 'Scan it' },
      ]);
    });

    await it('rejects the pending question when cancelled', async () => {
      const { surface } = recorder();
      const prompter = createSurfacePrompter(surface);
      const answer = prompter.ask('Code');
      prompter.cancel();
      let error: unknown = null;
      try {
        await answer;
      } catch (err) {
        error = err;
      }
      expect(error instanceof PromptCancelled).toBe(true);
      expect(prompter.cancelled).toBe(true);
    });

    await it('goes quiet after it was cancelled', async () => {
      const { steps, surface } = recorder();
      const prompter = createSurfacePrompter(surface);
      prompter.cancel();
      prompter.notify('late');
      prompter.showQr?.('late', 'late');
      let error: unknown = null;
      try {
        await prompter.ask('Again');
      } catch (err) {
        error = err;
      }
      expect(error instanceof PromptCancelled).toBe(true);
      expect(steps.length).toBe(0);
    });
  });
};
