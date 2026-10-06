import { describe, expect, it } from '@gjsify/unit';
import { GnomeUnavailableError } from '@curlew/protocol';

import { optionalNamespace } from '../../../../packages/gnome/src/optional.ts';

// Importing the *.gjs.ts modules here is itself the test: with a static `gi://Goa` / `gi://EBook`
// import they cannot even be loaded on a host without those typelibs (Node, macOS), which is
// the bug this guards — one missing optional typelib killed the whole app at startup.
import { check, listAccounts } from '../../../../packages/gnome/src/goa.gjs.ts';
import { searchContacts } from '../../../../packages/gnome/src/contacts.gjs.ts';
import { listEvents } from '../../../../packages/gnome/src/calendar.gjs.ts';
import { listMailTargets } from '../../../../packages/gnome/src/credentials.gjs.ts';
import { goa } from '../../../../packages/gnome/src/libs.gjs.ts';

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

  await describe('@curlew/gnome without the typelibs', async () => {
    const available = await goa.get().then(
      () => true,
      () => false,
    );

    await it('loads its modules and degrades instead of throwing', async () => {
      if (available) return; // a host with GOA: the real implementation, nothing to degrade
      const result = await check();
      expect(result.ok).toBe(false);
      expect(result.message).toContain('Goa typelib not available');
      expect((await rejection(listAccounts())) instanceof GnomeUnavailableError).toBe(true);
      expect((await rejection(listMailTargets())) instanceof GnomeUnavailableError).toBe(true);
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
