import { describe, expect, it } from '@gjsify/unit';

import { abortableSleep, errText } from '@curlew/protocol';

export default async () => {
  await describe('errText', async () => {
    await it('takes the message of an Error and stringifies anything else', async () => {
      expect(errText(new Error('boom'))).toBe('boom');
      expect(errText('plain')).toBe('plain');
      expect(errText(42)).toBe('42');
    });
  });

  await describe('abortableSleep', async () => {
    await it('resolves after the delay without a signal', async () => {
      const start = Date.now();
      await abortableSleep(30);
      expect(Date.now() - start >= 25).toBe(true);
    });

    await it('resolves at once when the signal is already aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const start = Date.now();
      await abortableSleep(5000, ctrl.signal);
      expect(Date.now() - start < 1000).toBe(true);
    });

    await it('resolves early, not rejects, when aborted while waiting', async () => {
      const ctrl = new AbortController();
      const start = Date.now();
      setTimeout(() => ctrl.abort(), 20);
      await abortableSleep(5000, ctrl.signal);
      expect(Date.now() - start < 1000).toBe(true);
    });

    await it('resolves after the delay with a live signal', async () => {
      const ctrl = new AbortController();
      await abortableSleep(20, ctrl.signal);
      expect(ctrl.signal.aborted).toBe(false);
    });
  });
};
