import { describe, expect, it } from '@gjsify/unit';

import { type Grant, hasGrant, isGranted, parseGrants } from '../../../src/core/grants.ts';
import { parseConfig } from '../../../src/core/config.ts';

// Placeholder targets only — no real calendar UID, account or address.
const CALENDAR: Grant = { capability: 'calendar.create', target: 'calendar-example' };
const XMPP: Grant = { capability: 'xmpp.send', target: 'bot/person@example.org' };
const CANARY: Grant = { capability: 'canary.write', target: 'canary' };

function rejects(raw: unknown, pattern: RegExp, canary = false): void {
  expect(() => parseGrants(raw, { canary })).toThrow(pattern);
}

export default async () => {
  await describe('isGranted — the decision behind the four gate canaries (ADR 0004)', async () => {
    // Canaries 1 and 2 (a tool declaring readOnlyHint:false, a tool with no annotations) are about
    // tool registration and belong to the gate; what the grant set contributes is "no grant, no write".
    await it('canary 3: a write whose capability is NOT granted is denied, for any target', async () => {
      for (const grants of [undefined, [], [XMPP]] as (Grant[] | undefined)[]) {
        expect(isGranted(grants, 'calendar.create', 'calendar-example')).toBe(false);
        expect(hasGrant(grants, 'calendar.create')).toBe(false);
      }
    });

    await it('canary 3: a granted capability is denied for a target the grant does not list', async () => {
      expect(isGranted([CALENDAR], 'calendar.create', 'calendar-other')).toBe(false);
      expect(isGranted([XMPP], 'xmpp.send', 'bot/other@example.org')).toBe(false);
      expect(isGranted([XMPP], 'xmpp.send', 'other/person@example.org')).toBe(false);
    });

    await it('canary 4: a granted capability with its exact target is allowed (positive control)', async () => {
      expect(isGranted([CANARY], 'canary.write', 'canary')).toBe(true);
      expect(isGranted([CALENDAR, XMPP], 'calendar.create', 'calendar-example')).toBe(true);
      expect(isGranted([CALENDAR, XMPP], 'xmpp.send', 'bot/person@example.org')).toBe(true);
      expect(hasGrant([CANARY], 'canary.write')).toBe(true);
    });

    await it('matches exactly: no prefix, no case folding, no other capability', async () => {
      expect(isGranted([CALENDAR], 'calendar.create', 'calendar-exampl')).toBe(false);
      expect(isGranted([CALENDAR], 'calendar.create', 'calendar-example-2')).toBe(false);
      expect(isGranted([CALENDAR], 'calendar.create', 'Calendar-Example')).toBe(false);
      expect(isGranted([CALENDAR], 'xmpp.send', 'calendar-example')).toBe(false);
      expect(isGranted([XMPP], 'xmpp.send', 'bot')).toBe(false);
    });
  });

  await describe('parseGrants', async () => {
    await it('a missing grants section means none', async () => {
      expect(parseGrants(undefined).length).toBe(0);
      expect(parseConfig('{}').grants.length).toBe(0);
    });

    await it('parses well-formed entries', async () => {
      const grants = parseGrants([CALENDAR, XMPP]);
      expect(grants.length).toBe(2);
      expect(isGranted(grants, 'xmpp.send', 'bot/person@example.org')).toBe(true);
    });

    await it('fails closed on a malformed entry, naming it', async () => {
      rejects({}, /config\.grants must be a list/);
      rejects(['calendar.create'], /grants\[0\] must be an object/);
      rejects([null], /grants\[0\] must be an object/);
      rejects([CALENDAR, { capability: 'calendar.create' }], /grants\[1\]\.target must be a string/);
      rejects([{ capability: 'calendar.create', target: 7 }], /target must be a string/);
      rejects([{ target: 'calendar-example' }], /capability undefined is not a known capability/);
      rejects([{ capability: 'calendar.create', target: 'x', targets: ['y'] }], /grants\[0\]\.targets is not a grant field/);
    });

    await it('rejects an unknown capability', async () => {
      rejects([{ capability: 'mail.send', target: 'acct' }], /"mail\.send" is not a known capability/);
      rejects([{ capability: '*', target: 'acct' }], /not a known capability/);
    });

    await it('rejects an empty, padded or wildcard target', async () => {
      rejects([{ capability: 'calendar.create', target: '' }], /target must be a non-empty string/);
      rejects([{ capability: 'calendar.create', target: ' calendar-example' }], /non-empty string/);
      rejects([{ capability: 'calendar.create', target: '*' }], /wildcards are not allowed/);
      rejects([{ capability: 'xmpp.send', target: 'bot/*' }], /wildcards are not allowed/);
    });

    await it('xmpp.send needs an <account>/<address> pair', async () => {
      rejects([{ capability: 'xmpp.send', target: 'bot' }], /"<account>\/<address>"/);
      rejects([{ capability: 'xmpp.send', target: '/person@example.org' }], /"<account>\/<address>"/);
      rejects([{ capability: 'xmpp.send', target: 'bot/' }], /"<account>\/<address>"/);
    });

    await it('canary.write is accepted only while the canary env is on', async () => {
      rejects([CANARY], /"canary\.write" is not a known capability/, false);
      expect(parseGrants([CANARY], { canary: true }).length).toBe(1);
      expect(() => parseConfig(JSON.stringify({ grants: [CANARY] }), { canary: false })).toThrow(/canary\.write/);
    });
  });
};
