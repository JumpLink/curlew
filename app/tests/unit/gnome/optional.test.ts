import { describe, expect, it } from '@gjsify/unit';
import { GnomeUnavailableError } from '@curlew/protocol';

import { holdOptionalGiWarnings, optionalNamespace } from '../../../../packages/gnome/src/optional.ts';

// Importing the *.gjs.ts modules here is itself the test: with a static `gi://Goa` / `gi://EBook`
// import they cannot even be loaded on a host without those typelibs (Node, macOS), which is
// the bug this guards — one missing optional typelib killed the whole app at startup.
import { check } from '../../../../packages/gnome/src/accounts.gjs.ts';
import { searchContacts } from '../../../../packages/gnome/src/contacts.gjs.ts';
import { listEvents } from '../../../../packages/gnome/src/calendar.gjs.ts';
import { eds } from '../../../../packages/gnome/src/libs.gjs.ts';

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
}

export default async () => {
  await describe('optional GI namespaces', async () => {
    await it('does not load until first use, and loads once', async () => {
      let calls = 0;
      const ns = optionalNamespace('Fake', async () => {
        calls++;
        return { ok: true };
      });
      expect(calls).toBe(0);
      expect((await ns.get()).ok).toBe(true);
      await ns.get();
      expect(calls).toBe(1);
    });

    await it('reports a failing loader as GnomeUnavailableError naming the namespace', async () => {
      const ns = optionalNamespace('EBook', async () => {
        throw new Error("Typelib file for namespace 'EBook' not found");
      });
      const err = await rejection(ns.get());
      expect(err instanceof GnomeUnavailableError).toBe(true);
      expect((err as Error).message).toContain('EBook typelib not available');
      expect((err as Error).message).toContain('not found');
    });

    await it('caches the failure instead of retrying the lookup', async () => {
      let calls = 0;
      const ns = optionalNamespace('Goa', async () => {
        calls++;
        throw new Error('missing');
      });
      await rejection(ns.get());
      await rejection(ns.get());
      expect(calls).toBe(1);
    });
  });

  await describe('held optional-GI warnings', async () => {
    const line = 'optional GI namespace Goa 1.0 is not available (typelib search path /x)';
    const capture = async (answered: boolean) => {
      const seen: { level: string; text: string }[] = [];
      const { warn, debug } = console;
      console.debug = (...a: unknown[]) => void seen.push({ level: 'debug', text: String(a[0]) });
      try {
        const held = await holdOptionalGiWarnings(async () => {
          console.warn(line);
          console.warn('something else');
          return 7;
        });
        console.warn = (...a: unknown[]) => void seen.push({ level: 'warn', text: String(a[0]) });
        expect(held.value).toBe(7);
        held.release(answered);
      } finally {
        console.warn = warn;
        console.debug = debug;
      }
      return seen;
    };

    await it('demotes the warning to debug when another route answered', async () => {
      const seen = await capture(true);
      expect(seen.length).toBe(1);
      expect(seen[0]!.level).toBe('debug');
      expect(seen[0]!.text).toContain('Goa 1.0');
    });

    await it('keeps it a warning when nothing answered', async () => {
      const seen = await capture(false);
      expect(seen.length).toBe(1);
      expect(seen[0]!.level).toBe('warn');
    });
  });

  await describe('@curlew/gnome without the typelibs', async () => {
    const available = await eds.get().then(
      () => true,
      () => false,
    );

    await it('loads its modules and degrades instead of throwing', async () => {
      if (available) return; // a host with GOA: the real implementation, nothing to degrade
      const result = await check();
      expect(result.ok).toBe(false);
      expect(result.message).toContain('unavailable');
    });

    await it('reports contacts and calendar as unavailable without a registry', async () => {
      if (available) return;
      const contacts = await rejection(searchContacts({ query: '' }));
      const events = await rejection(listEvents({ from: '2026-01-01', to: '2026-01-02' }));
      expect(contacts instanceof GnomeUnavailableError).toBe(true);
      expect(events instanceof GnomeUnavailableError).toBe(true);
    });
  });
};
