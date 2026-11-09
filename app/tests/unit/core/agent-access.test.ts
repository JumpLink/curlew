import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AgentAccessPolicy,
  type PolicyRule,
  type TemporaryGrant,
  addTemporaryGrant,
  defaultAgentAccess,
  endSession,
  expireTemporaryGrants,
  matchTemporaryGrant,
  parseAgentAccess,
  resolve,
} from '../../../src/core/agent-access.ts';
import { type Grant } from '../../../src/core/grants.ts';
import { defaultConfig, parseConfig, saveConfig } from '../../../src/core/config.ts';

// Placeholder accounts and addresses only.
const ACC = 'xmpp-abc123';
const FRIEND = 'friend@example.org';
const OTHER = 'other@example.org';

function policy(rules: PolicyRule[], askWithoutRule = true): AgentAccessPolicy {
  return { askWithoutRule, rules };
}

function parsed(raw: unknown, grants: Grant[] = []): AgentAccessPolicy {
  const result = parseAgentAccess(raw, grants);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.policy;
}

function errorsOf(raw: unknown, grants: Grant[] = []): string[] {
  const result = parseAgentAccess(raw, grants);
  if (result.ok) throw new Error('expected parse errors');
  return result.errors;
}

// @gjsify/unit's toEqual compares by reference; these are plain data, so compare their JSON.
function same(actual: unknown, expected: unknown): void {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

const SESSION = 's1';
const NOW = 1_000_000;

function temp(over: Partial<TemporaryGrant> = {}): TemporaryGrant {
  return { account: ACC, kind: 'read', session: SESSION, ...over };
}

export default async () => {
  await describe('agent access — resolution (ADR 0009 §2)', async () => {
    await it('the person’s own address is allowed for both kinds, whatever the rules say', async () => {
      const deny = policy([{ account: ACC, read: 'deny', write: 'deny' }], false);
      for (const kind of ['read', 'write'] as const) {
        same(resolve(deny, { account: ACC, contact: FRIEND, kind, self: true }), {
          mode: 'allow',
          reason: 'self',
        });
      }
    });

    await it('with no rule the default is ask, or deny when askWithoutRule is off', async () => {
      same(resolve(defaultAgentAccess(), { account: ACC, contact: FRIEND, kind: 'read' }), {
        mode: 'ask',
        reason: 'default',
      });
      same(resolve(policy([], false), { account: ACC, contact: FRIEND, kind: 'write' }), {
        mode: 'deny',
        reason: 'default',
      });
    });

    await it('an account rule covers every contact of that account and no other account', async () => {
      const p = policy([{ account: ACC, read: 'allow' }]);
      same(resolve(p, { account: ACC, contact: FRIEND, kind: 'read' }), {
        mode: 'allow',
        reason: 'rule',
      });
      expect(resolve(p, { account: ACC, contact: OTHER, kind: 'read' }).mode).toBe('allow');
      expect(resolve(p, { account: 'xmpp-zzz', contact: FRIEND, kind: 'read' }).reason).toBe('default');
    });

    await it('a contact rule beats the account rule, per kind', async () => {
      const p = policy([
        { account: ACC, read: 'deny', write: 'deny' },
        { account: ACC, contact: FRIEND, read: 'allow', write: 'ask' },
      ]);
      expect(resolve(p, { account: ACC, contact: FRIEND, kind: 'read' }).mode).toBe('allow');
      expect(resolve(p, { account: ACC, contact: FRIEND, kind: 'write' }).mode).toBe('ask');
      expect(resolve(p, { account: ACC, contact: OTHER, kind: 'read' }).mode).toBe('deny');
    });

    await it('a contact rule may also be narrower than the account: deny one contact of an open account', async () => {
      const p = policy([
        { account: ACC, read: 'allow', write: 'allow' },
        { account: ACC, contact: FRIEND, read: 'deny', write: 'deny' },
      ]);
      expect(resolve(p, { account: ACC, contact: FRIEND, kind: 'read' }).mode).toBe('deny');
      expect(resolve(p, { account: ACC, contact: OTHER, kind: 'write' }).mode).toBe('allow');
    });

    await it('a kind a contact rule leaves out falls through to the account rule, then to the default', async () => {
      const p = policy([
        { account: ACC, write: 'ask' },
        { account: ACC, contact: FRIEND, read: 'allow' },
      ]);
      // The ADR's example: reads quietly, asks before each send.
      expect(resolve(p, { account: ACC, contact: FRIEND, kind: 'read' }).mode).toBe('allow');
      same(resolve(p, { account: ACC, contact: FRIEND, kind: 'write' }), {
        mode: 'ask',
        reason: 'rule',
      });
      // The account rule leaves read out, so another contact's read falls to the default.
      same(resolve(p, { account: ACC, contact: OTHER, kind: 'read' }), {
        mode: 'ask',
        reason: 'default',
      });
      expect(
        resolve({ ...p, askWithoutRule: false }, { account: ACC, contact: OTHER, kind: 'read' }).mode,
      ).toBe('deny');
    });

    await it('a request without a contact is decided by the account rule only', async () => {
      const p = policy([
        { account: ACC, read: 'deny' },
        { account: ACC, contact: FRIEND, read: 'allow' },
      ]);
      expect(resolve(p, { account: ACC, kind: 'read' }).mode).toBe('deny');
    });

    await it('contact matching is exact: no case folding, no prefixes', async () => {
      const p = policy([{ account: ACC, contact: FRIEND, read: 'allow' }], false);
      expect(resolve(p, { account: ACC, contact: 'Friend@example.org', kind: 'read' }).mode).toBe('deny');
      expect(resolve(p, { account: ACC, contact: 'friend@example.or', kind: 'read' }).mode).toBe('deny');
    });
  });

  await describe('agent access — write needs read, on the resolved modes (ADR 0009 §1)', async () => {
    await it('a write whose read resolves to deny is deny, even from different rules', async () => {
      const p = policy([
        { account: ACC, read: 'deny' },
        { account: ACC, contact: FRIEND, write: 'allow' },
      ]);
      same(resolve(p, { account: ACC, contact: FRIEND, kind: 'write' }), {
        mode: 'deny',
        reason: 'rule',
      });
    });

    await it('a read deny from the default (askWithoutRule off) denies a write the contact rule allows', async () => {
      const p = policy([{ account: ACC, contact: FRIEND, write: 'allow' }], false);
      same(resolve(p, { account: ACC, contact: FRIEND, kind: 'write' }), {
        mode: 'deny',
        reason: 'default',
      });
    });

    await it('a write the rules already deny keeps its own reason', async () => {
      const p = policy([{ account: ACC, contact: FRIEND, write: 'deny' }], false);
      expect(resolve(p, { account: ACC, contact: FRIEND, kind: 'write' }).mode).toBe('deny');
    });

    await it('a read that is only ask does not block an allowed write', async () => {
      const p = policy([{ account: ACC, contact: FRIEND, write: 'allow' }]);
      same(resolve(p, { account: ACC, contact: FRIEND, kind: 'write' }), {
        mode: 'allow',
        reason: 'rule',
      });
    });

    await it('the person’s own address needs no read either', async () => {
      const p = policy([{ account: ACC, read: 'deny' }]);
      expect(resolve(p, { account: ACC, contact: FRIEND, kind: 'write', self: true }).mode).toBe('allow');
    });
  });

  await describe('agent access — temporary grants (ADR 0009 §2, §6)', async () => {
    const ctx = (grants: TemporaryGrant[], session = SESSION, now = NOW) => ({ grants, session, now });

    await it('turns ask into allow for the same session, scope and kind', async () => {
      const p = policy([{ account: ACC, contact: FRIEND, read: 'ask' }]);
      const request = { account: ACC, contact: FRIEND, kind: 'read' as const };
      expect(resolve(p, request).mode).toBe('ask');
      same(resolve(p, { ...request, temporary: ctx([temp({ contact: FRIEND })]) }), {
        mode: 'allow',
        reason: 'temporary',
      });
    });

    await it('also widens the default ask', async () => {
      const request = { account: ACC, contact: FRIEND, kind: 'read' as const };
      expect(resolve(defaultAgentAccess(), { ...request, temporary: ctx([temp()]) }).reason).toBe(
        'temporary',
      );
    });

    await it('never widens deny: not a rule deny, not a switched-off default', async () => {
      const request = { account: ACC, contact: FRIEND, kind: 'read' as const, temporary: ctx([temp()]) };
      expect(resolve(policy([{ account: ACC, read: 'deny' }]), request).mode).toBe('deny');
      expect(resolve(policy([], false), request).mode).toBe('deny');
    });

    await it('a contact deny stays final under an account-wide grant', async () => {
      const p = policy([{ account: ACC, contact: FRIEND, read: 'deny' }]);
      const request = { account: ACC, contact: FRIEND, kind: 'read' as const, temporary: ctx([temp()]) };
      expect(resolve(p, request).mode).toBe('deny');
    });

    await it('a rule that already says allow keeps its own reason', async () => {
      const p = policy([{ account: ACC, read: 'allow' }]);
      const request = { account: ACC, contact: FRIEND, kind: 'read' as const, temporary: ctx([temp()]) };
      same(resolve(p, request), { mode: 'allow', reason: 'rule' });
    });

    await it('belongs to one session', async () => {
      const request = {
        account: ACC,
        contact: FRIEND,
        kind: 'read' as const,
        temporary: ctx([temp()], 'another-session'),
      };
      expect(resolve(defaultAgentAccess(), request).mode).toBe('ask');
    });

    await it('belongs to one kind: a read grant does not allow a write', async () => {
      const request = { account: ACC, contact: FRIEND, kind: 'write' as const, temporary: ctx([temp()]) };
      expect(resolve(defaultAgentAccess(), request).mode).toBe('ask');
    });

    await it('belongs to one scope: a contact grant does not cover another contact, an account grant covers all', async () => {
      const p = defaultAgentAccess();
      const forFriend = ctx([temp({ contact: FRIEND })]);
      expect(resolve(p, { account: ACC, contact: OTHER, kind: 'read', temporary: forFriend }).mode).toBe(
        'ask',
      );
      expect(resolve(p, { account: ACC, kind: 'read', temporary: forFriend }).mode).toBe('ask');
      expect(resolve(p, { account: ACC, contact: OTHER, kind: 'read', temporary: ctx([temp()]) }).mode).toBe(
        'allow',
      );
      expect(
        resolve(p, { account: 'xmpp-zzz', contact: FRIEND, kind: 'read', temporary: ctx([temp()]) }).mode,
      ).toBe('ask');
    });

    await it('ends by time: live before expiresAt, over at it', async () => {
      const grant = temp({ expiresAt: NOW + 1000 });
      const request = { account: ACC, contact: FRIEND, kind: 'read' as const };
      const at = (now: number) =>
        resolve(defaultAgentAccess(), { ...request, temporary: ctx([grant], SESSION, now) }).mode;
      expect(at(NOW)).toBe('allow');
      expect(at(NOW + 999)).toBe('allow');
      expect(at(NOW + 1000)).toBe('ask');
    });

    await it('a write grant lets an ask write through only while read is not denied', async () => {
      const p = policy([
        { account: ACC, read: 'deny' },
        { account: ACC, contact: FRIEND, write: 'ask' },
      ]);
      const request = {
        account: ACC,
        contact: FRIEND,
        kind: 'write' as const,
        temporary: ctx([temp({ kind: 'write' })]),
      };
      expect(resolve(p, request).mode).toBe('deny');
    });

    await it('the helpers add (replacing a renewal), expire, match and end a session', async () => {
      const a = temp({ contact: FRIEND, expiresAt: NOW + 10 });
      const renewed = temp({ contact: FRIEND, expiresAt: NOW + 5000 });
      const b = temp({ session: 's2' });
      const added = addTemporaryGrant(addTemporaryGrant([], a), renewed);
      expect(added.length).toBe(1);
      expect(added[0]?.expiresAt).toBe(NOW + 5000);
      const both = addTemporaryGrant(added, b);
      expect(both.length).toBe(2);
      same(expireTemporaryGrants([a, b], NOW + 10), [b]);
      same(endSession(both, 's2'), added);
      expect(matchTemporaryGrant(ctx([a]), { account: ACC, contact: FRIEND, kind: 'read' })).toBe(true);
      expect(
        matchTemporaryGrant(ctx([a], SESSION, NOW + 10), { account: ACC, contact: FRIEND, kind: 'read' }),
      ).toBe(false);
      // The helpers never mutate their input.
      expect(both.length).toBe(2);
    });
  });

  await describe('agent access — parsing (ADR 0009 §8)', async () => {
    await it('a missing agentAccess is ask, no rules', async () => {
      same(parsed(undefined), { askWithoutRule: true, rules: [] });
      same(parsed({}), { askWithoutRule: true, rules: [] });
    });

    await it('keeps sendFilesUnasked only when it is on, and rejects a non-boolean', async () => {
      same(parsed({ sendFilesUnasked: false }), { askWithoutRule: true, rules: [] });
      same(parsed({ sendFilesUnasked: true }), { askWithoutRule: true, sendFilesUnasked: true, rules: [] });
      expect(errorsOf({ sendFilesUnasked: 'yes' }).join()).toContain(
        'sendFilesUnasked must be true or false',
      );
    });

    await it('parses the ADR example', async () => {
      const p = parsed({
        askWithoutRule: true,
        rules: [
          { account: ACC, read: 'allow', write: 'ask' },
          { account: ACC, contact: FRIEND, read: 'allow', write: 'allow' },
          { account: 'mail-def456', read: 'deny', write: 'deny' },
        ],
      });
      expect(p.rules.length).toBe(3);
      same(p.rules[1], { account: ACC, contact: FRIEND, read: 'allow', write: 'allow' });
    });

    await it('keeps askWithoutRule: false', async () => {
      expect(parsed({ askWithoutRule: false }).askWithoutRule).toBe(false);
    });

    await it('refuses two rules with the same scope, naming both', async () => {
      const errors = errorsOf({
        rules: [
          { account: ACC, read: 'allow' },
          { account: ACC, contact: FRIEND, read: 'allow' },
          { account: ACC, write: 'ask' },
        ],
      });
      expect(errors.length).toBe(1);
      expect(errors[0]).toMatch(/rules\[2\] has the same scope as rules\[0\]/);
    });

    await it('refuses a bad mode, naming the rule and the field', async () => {
      const errors = errorsOf({
        rules: [
          { account: ACC, read: 'allow' },
          { account: ACC, contact: FRIEND, read: 'yes' },
        ],
      });
      expect(errors[0]).toMatch(/rules\[1\]\.read "yes" must be "allow", "ask" or "deny"/);
      expect(errorsOf({ rules: [{ account: ACC, write: true }] })[0]).toMatch(/rules\[0\]\.write true/);
    });

    await it('refuses write allow or ask together with read deny in one rule', async () => {
      for (const write of ['allow', 'ask']) {
        const errors = errorsOf({ rules: [{ account: ACC, read: 'deny', write }] });
        expect(errors[0]).toMatch(/rules\[0\] sets write "(allow|ask)" with read "deny"/);
      }
      expect(parsed({ rules: [{ account: ACC, read: 'deny', write: 'deny' }] }).rules.length).toBe(1);
      expect(parsed({ rules: [{ account: ACC, read: 'allow', write: 'deny' }] }).rules.length).toBe(1);
    });

    await it('refuses unknown keys, at the top and in a rule', async () => {
      expect(errorsOf({ asksWithoutRule: true })[0]).toMatch(
        /agentAccess\.asksWithoutRule is not an agentAccess field/,
      );
      expect(errorsOf({ rules: [{ account: ACC, read: 'allow', writes: 'ask' }] })[0]).toMatch(
        /rules\[0\]\.writes is not a rule field/,
      );
      // `migrated` is internal and cannot be written into a file.
      expect(errorsOf({ rules: [{ account: ACC, read: 'allow', migrated: true }] })[0]).toMatch(
        /migrated is not a rule field/,
      );
    });

    await it('refuses malformed shapes and scopes', async () => {
      expect(errorsOf('x')[0]).toMatch(/must be an object/);
      expect(errorsOf({ askWithoutRule: 'yes' })[0]).toMatch(/askWithoutRule must be true or false/);
      expect(errorsOf({ rules: {} })[0]).toMatch(/rules must be a list/);
      expect(errorsOf({ rules: ['x'] })[0]).toMatch(/rules\[0\] must be an object/);
      expect(errorsOf({ rules: [{ read: 'allow' }] })[0]).toMatch(/rules\[0\]\.account must be a string/);
      expect(errorsOf({ rules: [{ account: '', read: 'allow' }] })[0]).toMatch(
        /\.account must be a non-empty/,
      );
      expect(errorsOf({ rules: [{ account: `${ACC}/${FRIEND}`, read: 'allow' }] })[0]).toMatch(
        /not "<account>\/<address>"/,
      );
      expect(errorsOf({ rules: [{ account: ACC, contact: '*', read: 'allow' }] })[0]).toMatch(/wildcards/);
      expect(errorsOf({ rules: [{ account: ACC, contact: ` ${FRIEND}`, read: 'allow' }] })[0]).toMatch(
        /whitespace/,
      );
      expect(errorsOf({ rules: [{ account: ACC }] })[0]).toMatch(/needs a read or a write mode/);
    });

    await it('collects every problem in one go', async () => {
      const errors = errorsOf({
        rules: [
          { account: ACC, read: 'x' },
          { account: ACC, contact: '?', write: 'y' },
        ],
      });
      expect(errors.length).toBe(3);
    });
  });

  await describe('agent access — migration of <backend>.send grants (ADR 0009 §8)', async () => {
    const XMPP: Grant = { capability: 'xmpp.send', target: `${ACC}/${FRIEND}` };

    await it('becomes a contact rule with read and write allow, with or without agentAccess', async () => {
      for (const raw of [undefined, { rules: [] }, { askWithoutRule: false }]) {
        const p = parsed(raw, [XMPP]);
        same(p.rules, [{ account: ACC, contact: FRIEND, read: 'allow', write: 'allow', migrated: true }]);
      }
    });

    await it('resolves with the reason migrated, for both kinds', async () => {
      const p = parsed(undefined, [XMPP]);
      same(resolve(p, { account: ACC, contact: FRIEND, kind: 'write' }), {
        mode: 'allow',
        reason: 'migrated',
      });
      same(resolve(p, { account: ACC, contact: FRIEND, kind: 'read' }), {
        mode: 'allow',
        reason: 'migrated',
      });
      expect(resolve(p, { account: ACC, contact: OTHER, kind: 'write' }).mode).toBe('ask');
    });

    await it('works for every <backend>.send, keeps the address verbatim, and merges the same pair', async () => {
      const p = parsed(undefined, [
        { capability: 'mail.send', target: 'mail-1/someone@example.org' },
        { capability: 'matrix.send', target: 'matrix-1/!room:example.org' },
        { capability: 'signal.send', target: 'signal-1/aci' },
        { capability: 'xmpp.send', target: `${ACC}/a/b` },
        { capability: 'mail.send', target: 'mail-1/someone@example.org' },
      ]);
      same(
        p.rules.map((rule) => `${rule.account}|${rule.contact}`),
        ['mail-1|someone@example.org', 'matrix-1|!room:example.org', 'signal-1|aci', `${ACC}|a/b`],
      );
    });

    await it('leaves non-send grants alone', async () => {
      same(parsed(undefined, [{ capability: 'canary.write', target: ACC }]).rules, []);
    });

    await it('an explicit contact rule for the same pair beats the migrated one', async () => {
      const p = parsed({ rules: [{ account: ACC, contact: FRIEND, read: 'allow', write: 'ask' }] }, [XMPP]);
      expect(p.rules.length).toBe(1);
      same(resolve(p, { account: ACC, contact: FRIEND, kind: 'write' }), {
        mode: 'ask',
        reason: 'rule',
      });
      const denied = parsed({ rules: [{ account: ACC, contact: FRIEND, read: 'deny', write: 'deny' }] }, [
        XMPP,
      ]);
      expect(resolve(denied, { account: ACC, contact: FRIEND, kind: 'write' }).mode).toBe('deny');
    });

    await it('a migrated rule beats an account rule, like any contact rule', async () => {
      const p = parsed({ rules: [{ account: ACC, read: 'deny', write: 'deny' }] }, [XMPP]);
      expect(resolve(p, { account: ACC, contact: FRIEND, kind: 'write' }).reason).toBe('migrated');
      expect(resolve(p, { account: ACC, contact: OTHER, kind: 'write' }).mode).toBe('deny');
    });

    await it('an explicit rule for another contact does not touch the migrated one', async () => {
      const p = parsed({ rules: [{ account: ACC, contact: OTHER, read: 'deny', write: 'deny' }] }, [XMPP]);
      expect(p.rules.length).toBe(2);
      expect(resolve(p, { account: ACC, contact: FRIEND, kind: 'write' }).mode).toBe('allow');
    });
  });

  await describe('agent access — config wiring', async () => {
    await it('parseConfig exposes the policy, with migration, and the default has none', async () => {
      same(defaultConfig().agentAccess, { askWithoutRule: true, rules: [] });
      const config = parseConfig(
        JSON.stringify({
          grants: [{ capability: 'xmpp.send', target: `${ACC}/${FRIEND}` }],
          agentAccess: { askWithoutRule: false, rules: [{ account: ACC, read: 'allow' }] },
        }),
      );
      expect(config.agentAccess.askWithoutRule).toBe(false);
      expect(config.agentAccess.rules.length).toBe(2);
      same(config.unknown, {});
    });

    await it('saveConfig writes the rules the person wrote and never a migrated one', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-access-'));
      const path = join(dir, 'config.json');
      const config = parseConfig(
        JSON.stringify({
          grants: [{ capability: 'xmpp.send', target: `${ACC}/${FRIEND}` }],
          agentAccess: { rules: [{ account: ACC, read: 'allow' }] },
        }),
      );
      saveConfig(config, path);
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      same(saved.agentAccess.rules, [{ account: ACC, read: 'allow' }]);
      expect(saved.grants.length).toBe(1);
      saveConfig(parseConfig(JSON.stringify({ grants: saved.grants })), path);
      expect(JSON.parse(readFileSync(path, 'utf8')).agentAccess).toBe(undefined);
    });

    await it('parseConfig fails on a bad rule and names it', async () => {
      expect(() =>
        parseConfig(JSON.stringify({ agentAccess: { rules: [{ account: ACC, read: 'maybe' }] } })),
      ).toThrow(/config\.agentAccess\.rules\[0\]\.read/);
    });
  });
};
