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

    it('runs the pull sync while the window is open, even with nothing to receive', async () => {
      const lines: string[] = [];
      let syncs = 0;
      let open: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      let finished = false;
      const receiver = hostReceiveLoop(
        'win32',
        // A window with mail accounts only: the receive loop is over at once and must not take
        // the pull sync with it.
        () => Promise.reject(new Error('nothing to receive')),
        (line) => lines.push(line),
        {
          pullSync: async () => {
            syncs++;
            await gate;
            finished = true;
          },
          pullSyncDelayMs: 1,
          pullSyncIntervalMs: 1,
        },
      );
      // Waits for the second tick instead of a fixed time: a loaded CI runner can be slower than 20 ms.
      const until = Date.now() + 5_000;
      while (!lines.some((l) => l.includes('still running')) && Date.now() < until) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      // One sync at a time, however many intervals passed.
      expect(syncs).toBe(1);
      expect(lines.some((l) => l.includes('still running — skipping this tick'))).toBe(true);
      let stopped = false;
      const stopping = receiver!.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      // The window closes the index when `stop()` resolves.
      expect(stopped).toBe(false);
      open();
      await stopping;
      expect(finished).toBe(true);
    });

    it('starts no pull sync when the host does not ask for one', async () => {
      const lines: string[] = [];
      const l = loop();
      const receiver = hostReceiveLoop('darwin', l.run, (line) => lines.push(line));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      await receiver!.stop();
      expect(l.aborted()).toBe(true);
      expect(lines.some((line) => line.includes('pull sync'))).toBe(false);
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
