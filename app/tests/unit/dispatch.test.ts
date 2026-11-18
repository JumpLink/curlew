import { describe, expect, it } from '@gjsify/unit';

import { hasWindowBundle, pickHandover as pick } from '../../src/dispatch.ts';

const show = (args: string[], runtime: { gjs: boolean; platform: string }) => {
  const h = pick(args, runtime);
  return h ? `${h.bundle} demo=${h.demo}` : null;
};
const gjs = { gjs: true, platform: 'linux' };
const nodeLinux = { gjs: false, platform: 'linux' };
const nodeMac = { gjs: false, platform: 'darwin' };
const nodeWin = { gjs: false, platform: 'win32' };

export default async () => {
  await describe('pickHandover: which window bundle an invocation opens', async () => {
    await it('keeps a bare `curlew` the CLI on GJS, and hands `window` and `demo` over', async () => {
      expect(show([], gjs)).toBe(null);
      expect(show(['window'], gjs)).toBe('./window.gjs.mjs demo=false');
      expect(show(['demo'], gjs)).toBe('./window.gjs.mjs demo=true');
    });

    await it('opens the Node window on macOS and Windows for no argument, `window` or `demo`', async () => {
      for (const runtime of [nodeMac, nodeWin]) {
        expect(show([], runtime)).toBe('./window.node.mjs demo=false');
        expect(show(['window'], runtime)).toBe('./window.node.mjs demo=false');
        expect(show(['demo'], runtime)).toBe('./window.node.mjs demo=true');
      }
    });

    await it('changes nothing on Node under Linux', async () => {
      for (const args of [[], ['window'], ['demo']]) expect(show(args, nodeLinux)).toBe(null);
    });

    await it('stays the CLI for any other command or extra arguments, on every runtime', async () => {
      for (const runtime of [gjs, nodeLinux, nodeMac, nodeWin])
        for (const args of [
          ['search', 'x'],
          ['--version'],
          ['--help'],
          ['window', '--x'],
          ['demo', 'x'],
          ['mcp'],
        ])
          expect(show(args, runtime)).toBe(null);
    });

    await it('knows where a window bundle exists', async () => {
      expect(hasWindowBundle(gjs)).toBe(true);
      expect(hasWindowBundle(nodeMac)).toBe(true);
      expect(hasWindowBundle(nodeWin)).toBe(true);
      expect(hasWindowBundle(nodeLinux)).toBe(false);
    });
  });
};
