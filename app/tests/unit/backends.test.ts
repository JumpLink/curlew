import { describe, expect, it, on } from '@gjsify/unit';

import { GnomeError, GnomeUnavailableError } from '@curlew/protocol';
import { goa } from '../../../packages/gnome/src/libs.gjs.ts';
import { check, listAccounts, listEvents, listMailTargets, searchContacts } from '@curlew/gnome';
import { getMessage, searchMail } from '@curlew/imap';
import { runChecks } from '../../src/frontends/cli/check.ts';
import { runtimeName } from '../../src/core/runtime.ts';
import { mcpErrorFrom } from '../../src/frontends/mcp/types.ts';

// @curlew/gnome runs the SAME gi:// implementation on every runtime (GJS native,
// Node/Bun via @gjsify/node-gi) — the constraint is a reachable GNOME session, not the JS
// runtime — so this half of the suite runs on both. Never asserts real account content,
// only the shape of the answer and the type it fails with.
//
// Whether a real session is reachable depends on where this happens to run, and the
// process cannot force that after the fact: GLib resolves the session bus address once,
// early, so `GLib.setenv('DBUS_SESSION_BUS_ADDRESS', …)` from already-running code does
// not reach it (measured — the getenv() readback shows the override while
// Goa.Client.new() still connects to the real bus). So the strict assertions below are
// gated on the DEAD-PATH PIN actually being in the environment (CI sets it, see ci.yml);
// without it the suite still runs, it just asserts the weaker contract.
//
// The second failure kind — a MISSING TYPELIB — is asserted in `gnome/optional.test.ts`: the
// typelibs load on first use, so it surfaces as a `GnomeUnavailableError` on either runtime.
//
// @curlew/imap still resolves to its "unavailable" stub on Node (GJS-only, unchanged by
// this refactor), so its half stays Node-only.
const DEAD_BUS = 'unix:path=/nonexistent';
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const pinnedToDeadPath = env.DBUS_SESSION_BUS_ADDRESS === DEAD_BUS;

// The GnomeError assertions below need the typelibs to LOAD and the bus to fail; on a host
// without them (macOS) the same call rejects with GnomeUnavailableError instead — a different,
// equally correct answer that optional.test.ts pins.

export default async () => {
  const typelibsLoad = await goa.get().then(
    () => true,
    () => false,
  );
  const nativeFailure = pinnedToDeadPath && typelibsLoad;

  await describe('@curlew/gnome', async () => {
    await it('check() answers with a name, a boolean and a reason', async () => {
      const result = await check();
      expect(result.name).toBe('GNOME');
      expect(typeof result.ok).toBe('boolean');
      expect(result.message.length > 0).toBe(true);
    });

    await it('an unreachable session is reported as unavailable, not as a missing runtime', async () => {
      if (!pinnedToDeadPath) return; // a workstation may have a live session — nothing to assert
      const result = await check();
      expect(result.ok).toBe(false);
      // postbote's own sentence leads, so the answer is the same on every runtime and in
      // every locale; the native cause follows it. This is what tells "no session bus"
      // apart from "no typelib", which reads as a typelib failure instead.
      expect(result.message).toMatch(/GNOME Online Accounts .* unavailable/i);
      // The deleted Node stub's text must never come back — there is no stub any more.
      expect(result.message).not.toMatch(/requires the GJS runtime/i);
    });

    await it('check() covers EDS, not just GOA', async () => {
      if (!pinnedToDeadPath) return; // a workstation may have a live session — nothing to assert
      // A GOA-only probe reports ok:true on a host that has GOA but no Evolution Data
      // Server, and then `postbote contacts` / `postbote calendar` fail on the next
      // command. Under the dead-path pin both daemons are unreachable, so ok:false here is
      // the answer for EITHER — which is the property: check() cannot say ok while the EDS
      // registry is unavailable.
      const result = await check();
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/GNOME Online Accounts .* unavailable/i);
    });

    await it('the runtime line says which backend the runtime gates', async () => {
      // The sentence is a CLAIM about the split (GNOME runs on Node, IMAP does not), and it
      // is the one line that gets stale silently: nothing else fails when it lies. Asserted
      // here so a change to either half of the split has to update it.
      const checks = await runChecks();
      const runtime = checks.checks.find((c) => c.name === 'runtime');
      expect(runtime).toBeDefined();
      const message = runtime?.message ?? '';
      if (runtimeName() === 'gjs') {
        expect(message).toMatch(/running on GJS$/);
      } else {
        expect(message).toMatch(/^running on Node — /);
        // Both halves, because both are true and the reader needs to know which applies.
        expect(message).toMatch(/GNOME accounts, contacts and calendar work here/);
        expect(message).toMatch(/IMAP mail backend needs GJS/);
      }
    });

    await it('the MCP and CLI answers for one failure read the same', async () => {
      if (!nativeFailure) return;
      // Same condition, same first words. `postbote check` said the stable sentence while
      // contacts_search answered `{"error":"Goa.Client.new: <locale string>"}`; the reader
      // of the second has no way to tell a missing bus from a missing typelib.
      const result = await check();
      let thrown = '';
      try {
        await listAccounts();
      } catch (err) {
        expect(err instanceof GnomeError).toBe(true);
        thrown = mcpErrorFrom(err).content[0].text;
      }
      if (thrown === '') return; // a live GOA answered; nothing to compare
      const body = JSON.parse(thrown) as { error: string };
      expect(body.error).toMatch(/^GNOME Online Accounts .* unavailable/i);
      expect(result.message.startsWith(body.error.slice(0, 20))).toBe(true);
    });

    await it('a GnomeError carries the GError domain and code', async () => {
      if (!nativeFailure) return;
      // Two fields named after a GError that nothing set were a trap: a reader would branch
      // on `err.code` and get `undefined`. Normalised to the same thing on both runtimes —
      // gjs reports the quark as a NUMBER (198), node-gi as the name — so a caller can tell
      // "we gave up waiting" from "GOA said no" without matching the message.
      let caught: unknown;
      try {
        await listAccounts();
      } catch (err) {
        caught = err;
      }
      expect(caught instanceof GnomeError).toBe(true);
      const e = caught as GnomeError;
      expect(typeof e.domain).toBe('string');
      expect(e.domain).toMatch(/quark$/);
      expect(typeof e.code).toBe('number');
    });

    await it('data functions fail with a GnomeError naming the call, never a bare GError', async () => {
      for (const call of [
        () => listAccounts(),
        () => searchContacts({ limit: 1 }),
        () => listEvents({ from: '2026-01-01', to: '2026-01-31', limit: 1 }),
        () => listMailTargets(),
      ]) {
        try {
          const result = await call();
          // Reachable session: a list, not a scalar and not a silent empty object.
          expect(Array.isArray(result)).toBe(true);
        } catch (err) {
          // Unreachable: one error type per cause — GnomeUnavailableError for a missing
          // typelib, GnomeError for any other native failure. Unwrapped, a GJS GLib.Error is
          // a boxed GObject and not even `instanceof Error` — the CLI could not classify it,
          // and `check()`'s message was the raw locale string.
          expect(err instanceof GnomeError || err instanceof GnomeUnavailableError).toBe(true);
          expect(err instanceof Error && err.message.length > 0).toBe(true);
        }
      }
    });
  });

  await on('Node.js', async () => {
    await describe('@curlew/imap (Node stub)', async () => {
      await it('mail functions throw instead of returning empty results', async () => {
        await expect(searchMail({})).rejects.toThrow(/GJS runtime/i);
        await expect(getMessage({ accountId: 'x', uid: '1' })).rejects.toThrow(/GJS runtime/i);
      });
    });
  });
};
