import { describe, expect, it } from '@gjsify/unit';

import { restartAfterMismatch } from '../../../src/window/mismatch-restart-model.ts';

function actions(failDaemon = false) {
  const calls: string[] = [];
  return {
    calls,
    relaunchWindow: () => void calls.push('window'),
    restartDaemon: async () => {
      calls.push('daemon');
      if (failDaemon) throw new Error('no systemd');
    },
  };
}

export default async () => {
  describe('restart after a wire mismatch', () => {
    it('relaunches the window when the window is older', async () => {
      const a = actions();
      expect(await restartAfterMismatch('window-older', a)).toBe(true);
      expect(a.calls).toStrictEqual(['window']);
    });

    it('restarts the daemon when the daemon is older', async () => {
      const a = actions();
      expect(await restartAfterMismatch('daemon-older', a)).toBe(true);
      expect(a.calls).toStrictEqual(['daemon']);
    });

    it('reports a failed daemon restart', async () => {
      const a = actions(true);
      expect(await restartAfterMismatch('daemon-older', a)).toBe(false);
    });
  });
};
