import { describe, expect, it } from '@gjsify/unit';

import {
  type AccessAsk,
  type AccessGate,
  type AccessPort,
  type AccessReply,
  AccessDeniedError,
  filterByAccess,
  previewOf,
  requireAccess,
  requireAccessAll,
  withAllowRule,
} from '../../../src/core/access.ts';
import type { AgentAccessPolicy, PolicyRule } from '../../../src/core/agent-access.ts';
import { defaultConfig } from '../../../src/core/config.ts';
import { agentSessionId } from '../../../src/core/actions/access.ts';
import { emailsOf, mailContacts } from '../../../src/core/actions/message-access.ts';

// Placeholder accounts and addresses only.
const ACC = 'xmpp-abc123';
const FRIEND = 'friend@example.org';
const OTHER = 'other@example.org';

const policy = (rules: PolicyRule[], askWithoutRule = true): AgentAccessPolicy => ({ askWithoutRule, rules });

function rig(rules: PolicyRule[], reply: AccessReply | null | Error = null, askWithoutRule = true) {
  const asked: AccessAsk[] = [];
  const port: AccessPort = {
    request: async (ask) => {
      asked.push(ask);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  const gate: AccessGate = { policy: policy(rules, askWithoutRule), port, session: 'mcp-1', oneShot: false };
  return { gate, asked };
}

const refusal = async (promise: Promise<unknown>): Promise<AccessDeniedError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AccessDeniedError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

export default async () => {
  await describe('requireAccess', async () => {
    await it('allows by rule without asking, and says why', async () => {
      const { gate, asked } = rig([{ account: ACC, contact: FRIEND, write: 'allow' }]);
      expect(await requireAccess(gate, { account: ACC, contact: FRIEND, kind: 'write' })).toBe('rule');
      expect(asked.length).toBe(0);
    });

    await it('asks for files even where a rule allows, but never for the own address', async () => {
      const allow = rig([{ account: ACC, contact: FRIEND, write: 'allow' }], {
        allowed: true,
        reason: 'once',
      });
      const target = { account: ACC, contact: FRIEND, kind: 'write' as const, confirmFiles: true };
      expect(await requireAccess(allow.gate, { ...target, attachments: ['a.pdf'] })).toBe('once');
      expect(allow.asked.length).toBe(1);
      expect((allow.asked[0].attachments ?? []).join()).toBe('a.pdf');
      const self = rig([], null);
      expect(await requireAccess(self.gate, { ...target, contact: 'me@example.org', self: true })).toBe(
        'self',
      );
      expect(self.asked.length).toBe(0);
    });

    await it('allows self without asking, whatever the rules say', async () => {
      const { gate, asked } = rig([{ account: ACC, write: 'deny' }]);
      expect(
        await requireAccess(gate, { account: ACC, contact: 'me@example.org', kind: 'write', self: true }),
      ).toBe('self');
      expect(asked.length).toBe(0);
    });

    await it('refuses a deny, naming the config key and an example rule', async () => {
      const { gate, asked } = rig([{ account: ACC, contact: FRIEND, write: 'deny' }]);
      const error = await refusal(requireAccess(gate, { account: ACC, contact: FRIEND, kind: 'write' }));
      expect(error.message).toContain('config.agentAccess.rules');
      expect(error.message).toContain('"write":"allow"');
      expect(error.reason).toBe('policy');
      expect(asked.length).toBe(0);
    });

    await it('refuses a missing rule without asking when askWithoutRule is false', async () => {
      const { gate, asked } = rig([], null, false);
      const error = await refusal(requireAccess(gate, { account: ACC, contact: FRIEND, kind: 'read' }));
      expect(error.message).toContain('askWithoutRule');
      expect(asked.length).toBe(0);
    });

    await it('asks on ask and passes the session, the preview and no text elsewhere', async () => {
      const { gate, asked } = rig([], { allowed: true, reason: 'once' });
      const reason = await requireAccess(gate, {
        account: ACC,
        contact: FRIEND,
        kind: 'write',
        preview: 'Hello',
      });
      expect(reason).toBe('once');
      expect(JSON.stringify(asked)).toBe(
        JSON.stringify([
          {
            account: ACC,
            contact: FRIEND,
            kind: 'write',
            session: 'mcp-1',
            oneShot: false,
            preview: 'Hello',
          },
        ]),
      );
    });

    await it('returns session, temporary and rule answers as they are', async () => {
      for (const reason of ['session', 'temporary', 'rule'] as const) {
        const { gate } = rig([], { allowed: true, reason });
        expect(await requireAccess(gate, { account: ACC, contact: FRIEND, kind: 'read' })).toBe(reason);
      }
    });

    await it('refuses every refusal the daemon can give, each with its own sentence', async () => {
      const messages = new Set<string>();
      for (const reason of ['denied', 'denied-before', 'timeout', 'dismissed', 'unavailable'] as const) {
        const { gate } = rig([], { allowed: false, reason });
        const error = await refusal(requireAccess(gate, { account: ACC, contact: FRIEND, kind: 'read' }));
        expect(error.reason).toBe(reason);
        messages.add(error.message);
      }
      expect(messages.size).toBe(5);
    });

    await it('says so when no daemon answers or the call fails', async () => {
      for (const reply of [null, new Error('boom')]) {
        const { gate } = rig([], reply);
        const error = await refusal(requireAccess(gate, { account: ACC, contact: FRIEND, kind: 'write' }));
        expect(error.message).toContain('`curlew daemon` is not running');
        expect(error.reason).toBe('unavailable');
      }
    });
  });

  await describe('requireAccessAll', async () => {
    await it('needs every contact, and falls back to the account when there is none', async () => {
      const { gate, asked } = rig([{ account: ACC, contact: FRIEND, read: 'allow' }], {
        allowed: false,
        reason: 'denied',
      });
      await refusal(requireAccessAll(gate, ACC, [FRIEND, OTHER], 'read'));
      expect(asked.map((a) => a.contact)).toEqualArray([OTHER]);
      await refusal(requireAccessAll(gate, ACC, [], 'read'));
      expect(asked[1].contact).toBe(undefined);
    });
  });

  await describe('filterByAccess', async () => {
    const hits = [
      { id: 1, account: ACC, contacts: [FRIEND] },
      { id: 2, account: ACC, contacts: [OTHER] },
      { id: 3, account: ACC, contacts: [FRIEND, OTHER] },
    ];

    await it('keeps what a rule allows and counts the rest, without ever prompting', async () => {
      const { gate, asked } = rig([{ account: ACC, contact: FRIEND, read: 'allow' }], {
        allowed: false,
        reason: 'policy',
      });
      const { kept, withheld } = await filterByAccess(gate, hits, (h) => h);
      expect(kept.map((h) => h.id)).toEqualArray([1]);
      expect(withheld).toBe(2);
      expect(asked.every((a) => a.probe === true)).toBe(true);
    });

    await it('keeps what a session grant allows, which only the daemon knows', async () => {
      const { gate, asked } = rig([], { allowed: true, reason: 'temporary' });
      const { kept } = await filterByAccess(gate, hits, (h) => h);
      expect(kept.length).toBe(3);
      // One probe per contact, not per hit.
      expect(asked.length).toBe(2);
    });

    await it('withholds a deny, and everything when no daemon answers', async () => {
      const { gate } = rig([{ account: ACC, read: 'deny' }]);
      expect((await filterByAccess(gate, hits, (h) => h)).kept.length).toBe(0);
      const down = rig([], new Error('no bus'));
      expect((await filterByAccess(down.gate, hits, (h) => h)).withheld).toBe(3);
    });
  });

  await describe('withAllowRule', async () => {
    const base = () => defaultConfig();

    await it('adds a rule with only the asked kind', async () => {
      const next = withAllowRule(base(), { account: ACC, contact: FRIEND, kind: 'write' });
      expect(JSON.stringify(next.agentAccess.rules)).toBe(
        JSON.stringify([{ account: ACC, contact: FRIEND, write: 'allow' }]),
      );
    });

    await it('widens an explicit rule of the same scope and leaves a migrated one alone', async () => {
      const config = base();
      config.agentAccess.rules = [
        { account: ACC, contact: FRIEND, write: 'allow', migrated: true },
        { account: ACC, contact: FRIEND, read: 'deny' },
      ];
      const next = withAllowRule(config, { account: ACC, contact: FRIEND, kind: 'write' });
      expect(JSON.stringify(next.agentAccess.rules[0])).toBe(
        JSON.stringify({ account: ACC, contact: FRIEND, write: 'allow', migrated: true }),
      );
      expect(JSON.stringify(next.agentAccess.rules[1])).toBe(
        JSON.stringify({ account: ACC, contact: FRIEND, read: 'deny', write: 'allow' }),
      );
    });
  });

  await describe('helpers', async () => {
    await it('shortens a preview to one line of at most 80 characters', async () => {
      expect(previewOf('a\n  b')).toBe('a b');
      expect(previewOf('x'.repeat(200))?.length).toBe(80);
      expect(previewOf('   ')).toBe(undefined);
    });

    await it('gives an MCP server one stable session and a CLI call its own', async () => {
      expect(agentSessionId('mcp')).toBe(agentSessionId('mcp'));
      expect(agentSessionId('cli').startsWith('cli-')).toBe(true);
    });

    await it('reads the addresses of a stored list', async () => {
      expect(emailsOf('Ann <a@example.org>, b@example.org')).toEqualArray(['a@example.org', 'b@example.org']);
    });

    await it('belongs a mail to its sender, or to all its recipients when the account sent it', async () => {
      const own = async (_a: string, address: string) => address === 'me@example.org';
      expect(await mailContacts(own, ACC, [FRIEND], ['me@example.org'])).toEqualArray([FRIEND]);
      expect(await mailContacts(own, ACC, ['me@example.org'], [FRIEND, OTHER])).toEqualArray([FRIEND, OTHER]);
    });
  });
};
