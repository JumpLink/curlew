import { describe, expect, it } from '@gjsify/unit';

import {
  backgroundRequest,
  backgroundResult,
  unavailableResult,
} from '../../../src/core/lib/autostart-portal-model.ts';

export default async () => {
  describe('the Background portal request', () => {
    it('names the command and asks for autostart when it is wanted', () => {
      expect(backgroundRequest(true, ['curlew', 'daemon'])).toStrictEqual({
        autostart: true,
        commandline: ['curlew', 'daemon'],
      });
    });

    it('sends no command when autostart is off, so the portal removes the entry', () => {
      expect(backgroundRequest(false, ['curlew', 'daemon'])).toStrictEqual({
        autostart: false,
        commandline: null,
      });
    });

    it('copies the command, so a caller cannot change it afterwards', () => {
      const source = ['curlew', 'daemon'];
      const request = backgroundRequest(true, source);
      source.push('extra');
      expect(request.commandline).toStrictEqual(['curlew', 'daemon']);
    });
  });

  describe('the Background portal answer', () => {
    it('enables when the portal allowed it', () => {
      expect(backgroundResult(true, true)).toStrictEqual({ ok: true });
    });

    it('refuses with a reason when the person declined', () => {
      const result = backgroundResult(false, true);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length > 0).toBe(true);
    });

    it('treats a switch-off as done even when background is not allowed', () => {
      expect(backgroundResult(false, false)).toStrictEqual({ ok: true });
      expect(backgroundResult(true, false)).toStrictEqual({ ok: true });
    });

    it('reads a missing portal as unavailable with a reason', () => {
      const result = unavailableResult();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length > 0).toBe(true);
    });
  });
};
