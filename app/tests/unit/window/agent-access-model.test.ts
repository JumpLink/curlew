import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type AgentAccessPolicy, type PolicyRule, parseAgentAccess } from '../../../src/core/agent-access.ts';
import { withAllowRule } from '../../../src/core/access.ts';
import { loadConfig, saveConfig } from '../../../src/core/config.ts';
import {
  type EditResult,
  type PolicyEdit,
  addRule,
  groupByAccount,
  removeRule,
  ruleTitle,
  setAskWithoutRule,
  setMode,
} from '../../../src/window/agent-access-model.ts';
import { loadAgentAccess, updateAgentAccess } from '../../../src/window/agent-access-store.ts';

// Synthetic accounts and addresses only.
const A = 'xmpp-abc123';
const B = 'mail-def456';
const ANNA = 'anna@example.org';
const BEN = 'ben@example.org';

const policy = (rules: PolicyRule[], askWithoutRule = true): AgentAccessPolicy => ({ askWithoutRule, rules });

// @gjsify/unit's toEqual compares by reference; these are plain data, so compare their JSON.
function same(actual: unknown, expected: unknown): void {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

function applied(edit: PolicyEdit, from: AgentAccessPolicy): AgentAccessPolicy {
  const result = edit(from);
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.policy;
}

function errorOf(result: EditResult): string {
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

function tempConfig(): string {
  return join(mkdtempSync(join(tmpdir(), 'curlew-window-')), 'config.json');
}

export default async () => {
  await describe('agent access page — grouping', async () => {
    await it('groups by account, whole-account rule apart from contact rules', async () => {
      const groups = groupByAccount(
        policy([
          { account: A, contact: BEN, read: 'allow' },
          { account: B, read: 'deny', write: 'deny' },
          { account: A, read: 'ask' },
          { account: A, contact: ANNA, read: 'allow', write: 'ask' },
        ]),
      );
      expect(groups.length).toBe(2);
      expect(groups[0].account).toBe(A);
      expect(groups[0].whole?.read).toBe('ask');
      expect(groups[0].whole?.write).toBe('unset');
      same(
        groups[0].contacts.map((c) => c.contact),
        [ANNA, BEN],
      );
      expect(groups[1].account).toBe(B);
      expect(groups[1].contacts.length).toBe(0);
    });

    await it('labels an account by its identity and falls back to the id', async () => {
      const groups = groupByAccount(
        policy([
          { account: A, read: 'allow' },
          { account: B, read: 'allow' },
        ]),
        new Map([[A, 'me@example.org']]),
      );
      expect(groups[0].label).toBe('me@example.org');
      expect(groups[1].label).toBe(B);
    });

    await it('shows Name (address), and the bare address without a name', async () => {
      const groups = groupByAccount(
        policy([
          { account: A, contact: ANNA, read: 'allow' },
          { account: A, contact: BEN, read: 'allow' },
        ]),
        new Map(),
        (_account, contact) => (contact === ANNA ? 'Anna Example' : undefined),
      );
      const [anna, ben] = groups[0].contacts;
      expect(ruleTitle(anna, 'x')).toBe(`Anna Example (${ANNA})`);
      expect(ruleTitle(ben, 'x')).toBe(BEN);
      expect(ruleTitle({ account: A, read: 'allow', write: 'unset', migrated: false }, 'Whole account')).toBe(
        'Whole account',
      );
    });

    await it('sanitizes names and labels that come from other people', async () => {
      const groups = groupByAccount(
        policy([{ account: A, contact: ANNA, read: 'allow' }]),
        new Map([[A, 'Me\nsecond line']]),
        () => 'Anna\u202e\nEvil',
      );
      expect(groups[0].label).toBe('Me second line');
      expect(groups[0].contacts[0].name).toBe('Anna Evil');
    });

    await it('marks a migrated rule', async () => {
      const groups = groupByAccount(
        policy([{ account: A, contact: ANNA, read: 'allow', write: 'allow', migrated: true }]),
      );
      expect(groups[0].contacts[0].migrated).toBe(true);
    });
  });

  await describe('agent access page — edits', async () => {
    await it('toggles askWithoutRule and leaves the rules alone', async () => {
      const from = policy([{ account: A, read: 'allow' }]);
      const next = applied(setAskWithoutRule(false), from);
      expect(next.askWithoutRule).toBe(false);
      same(next.rules, from.rules);
    });

    await it('sets a mode, and clears one with unset', async () => {
      const from = policy([{ account: A, contact: ANNA, read: 'allow', write: 'ask' }]);
      same(applied(setMode({ account: A, contact: ANNA }, 'write', 'allow'), from).rules, [
        { account: A, contact: ANNA, read: 'allow', write: 'allow' },
      ]);
      same(applied(setMode({ account: A, contact: ANNA }, 'write', 'unset'), from).rules, [
        { account: A, contact: ANNA, read: 'allow' },
      ]);
    });

    await it('refuses to leave a rule with neither mode', async () => {
      const from = policy([{ account: A, read: 'allow' }]);
      expect(errorOf(setMode({ account: A }, 'read', 'unset')(from))).toBe('needs-mode');
    });

    await it('read deny takes a writing mode down to deny; write allow on a denied read is refused', async () => {
      const from = policy([{ account: A, read: 'allow', write: 'allow' }]);
      same(applied(setMode({ account: A }, 'read', 'deny'), from).rules, [
        { account: A, read: 'deny', write: 'deny' },
      ]);
      const denied = policy([{ account: A, read: 'deny', write: 'deny' }]);
      expect(errorOf(setMode({ account: A }, 'write', 'ask')(denied))).toBe('write-needs-read');
      expect(applied(setMode({ account: A }, 'write', 'deny'), denied).rules.length).toBe(1);
    });

    await it('refuses to edit a rule that is gone', async () => {
      expect(errorOf(setMode({ account: A }, 'read', 'allow')(policy([])))).toBe('missing');
      expect(errorOf(removeRule({ account: A })(policy([])))).toBe('missing');
    });

    await it('adds an account rule and a contact rule', async () => {
      const one = applied(addRule({ account: A, read: 'ask' }), policy([]));
      const two = applied(addRule({ account: A, contact: ` ${ANNA} `, read: 'allow', write: 'deny' }), one);
      same(two.rules, [
        { account: A, read: 'ask' },
        { account: A, contact: ANNA, read: 'allow', write: 'deny' },
      ]);
    });

    await it('refuses a duplicate, a rule without a mode, a bad combination and a wildcard', async () => {
      const from = policy([{ account: A, contact: ANNA, read: 'allow' }]);
      expect(errorOf(addRule({ account: A, contact: ANNA, write: 'deny' })(from))).toBe('duplicate');
      expect(errorOf(addRule({ account: B })(from))).toBe('needs-mode');
      expect(errorOf(addRule({ account: B, read: 'deny', write: 'ask' })(from))).toBe('write-needs-read');
      expect(errorOf(addRule({ account: B, contact: '*@example.org', read: 'allow' })(from))).toBe('invalid');
      expect(errorOf(addRule({ account: '  ', read: 'allow' })(from))).toBe('invalid');
    });

    await it('removes a rule', async () => {
      const from = policy([
        { account: A, read: 'allow' },
        { account: A, contact: ANNA, read: 'deny', write: 'deny' },
      ]);
      same(applied(removeRule({ account: A, contact: ANNA }), from).rules, [{ account: A, read: 'allow' }]);
    });
  });

  await describe('agent access page — migrated rules', async () => {
    const migrated: PolicyRule = { account: A, contact: ANNA, read: 'allow', write: 'allow', migrated: true };

    await it('cannot be removed from here', async () => {
      expect(errorOf(removeRule({ account: A, contact: ANNA })(policy([migrated])))).toBe('migrated');
    });

    await it('the first edit makes it an explicit rule, which the file then keeps', async () => {
      const next = applied(setMode({ account: A, contact: ANNA }, 'write', 'ask'), policy([migrated]));
      same(next.rules, [{ account: A, contact: ANNA, read: 'allow', write: 'ask' }]);
    });

    await it('adding a rule for the same scope replaces it instead of failing as a duplicate', async () => {
      const next = applied(
        addRule({ account: A, contact: ANNA, read: 'deny', write: 'deny' }),
        policy([migrated]),
      );
      same(next.rules, [{ account: A, contact: ANNA, read: 'deny', write: 'deny' }]);
    });

    await it('through the store: the converted rule is written, the migrated one comes back once it is removed', async () => {
      const path = tempConfig();
      writeFileSync(
        path,
        JSON.stringify({
          backends: { xmpp: { enabled: true } },
          grants: [{ capability: 'xmpp.send', target: `${A}/${ANNA}` }],
        }),
      );
      const loaded = loadAgentAccess(path);
      expect(loaded.policy.rules[0].migrated).toBe(true);

      const edited = updateAgentAccess(setMode({ account: A, contact: ANNA }, 'write', 'ask'), path);
      expect(edited.ok).toBe(true);
      const afterEdit = loadConfig(path).agentAccess.rules;
      same(afterEdit, [{ account: A, contact: ANNA, read: 'allow', write: 'ask' }]);
      const onDisk = JSON.parse(readFileSync(path, 'utf8'));
      expect(onDisk.grants.length).toBe(1);

      expect(updateAgentAccess(removeRule({ account: A, contact: ANNA }), path).ok).toBe(true);
      const back = loadConfig(path).agentAccess.rules;
      expect(back.length).toBe(1);
      expect(back[0].migrated).toBe(true);
    });
  });

  await describe('agent access page — the file', async () => {
    await it('an edit keeps a rule the daemon added after the page last read the file', async () => {
      const path = tempConfig();
      saveConfig({ ...loadConfig(path), agentAccess: policy([{ account: A, read: 'allow' }]) }, path);

      // The page has this view open …
      const shown = loadAgentAccess(path).policy;
      // … then the daemon saves an "Always" answer.
      saveConfig(withAllowRule(loadConfig(path), { account: B, contact: BEN, kind: 'read' }), path);

      // The page edits a rule it knows. Applying the edit to its stale view would drop the new rule.
      expect(shown.rules.length).toBe(1);
      expect(updateAgentAccess(setMode({ account: A }, 'read', 'deny'), path).ok).toBe(true);
      same(loadConfig(path).agentAccess.rules, [
        { account: A, read: 'deny' },
        { account: B, contact: BEN, read: 'allow' },
      ]);
    });

    await it('writes only agentAccess: other keys survive, the mode stays 0600, nothing is written on a refusal', async () => {
      const path = tempConfig();
      writeFileSync(
        path,
        JSON.stringify({
          backends: { mail: { enabled: true } },
          senders: { 'news@example.org': 'automated' },
          somethingNew: { kept: true },
        }),
      );
      expect(updateAgentAccess(addRule({ account: A, read: 'ask' }), path).ok).toBe(true);
      const written = JSON.parse(readFileSync(path, 'utf8'));
      same(written.senders, { 'news@example.org': 'automated' });
      same(written.somethingNew, { kept: true });
      same(written.backends, { mail: { enabled: true } });
      same(written.agentAccess, { askWithoutRule: true, rules: [{ account: A, read: 'ask' }] });
      expect((statSync(path).mode & 0o777).toString(8)).toBe('600');

      const before = readFileSync(path, 'utf8');
      expect(updateAgentAccess(addRule({ account: A, read: 'allow' }), path).ok).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(before);
    });

    await it('reads the enabled backends for the account labels', async () => {
      const path = tempConfig();
      writeFileSync(
        path,
        JSON.stringify({ backends: { mail: { enabled: true }, xmpp: { enabled: false } } }),
      );
      same(loadAgentAccess(path).backends, ['mail']);
      const result = parseAgentAccess(undefined);
      expect(result.ok).toBe(true);
    });
  });
};
