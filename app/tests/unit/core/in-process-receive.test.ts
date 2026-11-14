import { describe, expect, it } from '@gjsify/unit';

import { hostReceiveLoop, type ReceiveLoop } from '../../../src/core/lib/in-process-receive.ts';
import { backgroundService } from '../../../src/core/platform.ts';

function loop(): { run: ReceiveLoop; started: () => number; aborted: () => boolean } {
  let starts = 0;
  let aborted = false;
  const run: ReceiveLoop = ({ signal }) => {
    starts++;
    return new Promise((resolve) =>
      signal.addEventListener('abort', () => {
        aborted = true;
        resolve(undefined);
      }),
    );
  };
  return { run, started: () => starts, aborted: () => aborted };
}

export default async () => {
  describe('the background service capability', () => {
    it('is while-open on Windows and macOS, systemd or portal on Linux', () => {
      expect(backgroundService('win32')).toBe('while-open');
      expect(backgroundService('darwin')).toBe('while-open');
      expect(backgroundService('win32', true)).toBe('while-open');
      expect(backgroundService('linux')).toBe('systemd');
      expect(backgroundService('linux', true)).toBe('portal');
    });
  });

  describe('receiving inside the window', () => {
    it('starts the loop on win32 and darwin and stops it with the last batch', async () => {
      for (const platform of ['win32', 'darwin']) {
        const l = loop();
        const receiver = hostReceiveLoop(platform, l.run);
        expect(receiver === null).toBe(false);
        expect(l.started()).toBe(1);
        await receiver!.stop();
        expect(l.aborted()).toBe(true);
      }
    });

    it('starts nothing on Linux, where the daemon is the receiver', () => {
      const l = loop();
      expect(hostReceiveLoop('linux', l.run)).toBe(null);
      expect(l.started()).toBe(0);
    });

    it('logs a loop that ends with an error instead of throwing', async () => {
      const lines: string[] = [];
      const receiver = hostReceiveLoop(
        'win32',
        () => Promise.reject(new Error('nothing to receive')),
        (line) => lines.push(line),
      );
      await receiver!.stop();
      expect(lines.length).toBe(1);
    });
  });
};
