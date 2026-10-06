import { describe, expect, it } from '@gjsify/unit';

import { isGjs, runtimeName } from '../../src/core/runtime.ts';

// The probe takes its global as a parameter so both branches are exercised on BOTH runtimes —
// otherwise each run would only ever cover the branch it happens to be on, and a regression in
// the other would surface as a mis-detected runtime at load time rather than as a failing test.
export default async () => {
  await describe('runtime detection', async () => {
    await it('detects GJS by the legacy `imports` global', async () => {
      expect(isGjs({ imports: {} })).toBe(true);
      expect(runtimeName({ imports: {} })).toBe('gjs');
    });

    await it('detects Node by the absence of it', async () => {
      expect(isGjs({})).toBe(false);
      expect(runtimeName({})).toBe('node');
    });

    await it('agrees with the actual runtime it is running on', async () => {
      expect(['gjs', 'node']).toContain(runtimeName());
    });
  });

  await describe('the globals a bundled browser library reaches for', async () => {
    // mtcute's web build read `navigator` unguarded and registered a `beforeunload` handler on
    // `window`, which is what `packages/telegram/src/client.ts` used to override its platform
    // around (gjsify#1835, gjsify#1836). Both fixes exist, so this pins the behaviour they
    // bought on BOTH runtimes — and it reads the real globals, not a fixture, because the whole
    // claim is about what the bundle's global object carries at load time.
    //
    // Note what is NOT asserted: that `navigator.onLine` exists. It does not, on either runtime
    // (Node's navigator is DOM-less, and so is gjsify's), so mtcute's own guard takes the
    // browser branch off and curlew's connection errors are what report an outage.
    await it('has a navigator object, without an onLine to read', async () => {
      expect(typeof navigator).toBe('object');
      expect(navigator).not.toBeNull();
      expect('onLine' in navigator).toBe(false);
    });

    // The `window` half is per-runtime and the difference is the point, so both branches run on
    // BOTH runtimes: read what is there rather than branching on the runtime.
    await it('makes `window` follow the runtime, and a browser branch therefore work', async () => {
      const target = globalThis as unknown as {
        addEventListener?: (type: string, fn: () => void) => void;
        removeEventListener?: (type: string, fn: () => void) => void;
        dispatchEvent?: (event: Event) => boolean;
      };
      // GJS: `--app gjs` keeps window's identity define (ADR 0079) but the global became an
      // EventTarget, so mtcute's `window.addEventListener('beforeunload')` is real. Registered
      // and then fired, so a stub that swallowed the call could not pass this.
      //
      // Node: there is no `window` at all, so mtcute's `typeof window === 'undefined'` guard
      // fails and it never takes the browser branch. Nothing to fire — the absence IS the
      // assertion, and a bundle that defined `window` as `globalThis` here would fail it.
      if (typeof target.addEventListener === 'function') {
        let fired = 0;
        const listener = (): void => {
          fired += 1;
        };
        target.addEventListener('beforeunload', listener);
        try {
          target.dispatchEvent?.(new Event('beforeunload'));
        } finally {
          target.removeEventListener?.('beforeunload', listener);
        }
        expect(fired).toBe(1);
      } else {
        expect((globalThis as { window?: unknown }).window).toBeUndefined();
      }
    });
  });
};
