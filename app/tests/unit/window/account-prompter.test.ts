import { chooseOption } from '@curlew/protocol';
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

    await it('passes a skip label through, and only when the backend offers one', async () => {
      const { steps, surface } = recorder();
      const prompter = createSurfacePrompter(surface);
      const answer = prompter.ask('Phone number', { skip: 'Scan a QR Code Instead' });
      const step = steps[0];
      if (step.kind !== 'ask') throw new Error('expected a question');
      expect(step.skip).toBe('Scan a QR Code Instead');
      step.submit('');
      expect(await answer).toBe('');
      void prompter.ask('Name');
      const plain = steps[1];
      expect(plain.kind === 'ask' && plain.skip).toBe(undefined);
    });

    await it('offers a choice and resolves with the picked id, once', async () => {
      const { steps, surface } = recorder();
      const prompter = createSurfacePrompter(surface);
      const options = [
        { id: 'phone', title: 'Phone number' },
        { id: 'qr', title: 'QR code', subtitle: 'Needs another device' },
      ];
      const picked = chooseOption(prompter, 'How?', options);
      const step = steps[0];
      if (step.kind !== 'choose') throw new Error('expected a choice');
      expect(step.label).toBe('How?');
      expect(step.options.length).toBe(2);
      step.submit('qr');
      step.submit('phone');
      expect(await picked).toBe('qr');
    });

    await it('takes the first option when the prompter cannot choose, or there is only one', async () => {
      const ask = async () => '';
      const options = [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ];
      expect(await chooseOption({ ask, notify: () => {} }, 'How?', options)).toBe('a');
      const { steps, surface } = recorder();
      expect(await chooseOption(createSurfacePrompter(surface), 'How?', [options[1]])).toBe('b');
      expect(steps.length).toBe(0);
    });

    await it('refuses an answer that was not offered', async () => {
      const choose = async () => 'z';
      let message = '';
      await chooseOption({ ask: async () => '', notify: () => {}, choose }, 'How?', [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ]).catch((err: Error) => (message = err.message));
      expect(message).toMatch(/not one of the offered options/);
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
