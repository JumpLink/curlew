import { describe, expect, it } from '@gjsify/unit';

import { type PromptChoice, type PromptUi, AccessBroker } from '../../../src/core/access-broker.ts';
import { ACCESS_PROMPT_TIMEOUT_MS, type AccessAsk } from '../../../src/core/access.ts';
import { contactNameFromIndex } from '../../../src/core/lib/contact-name.ts';
import { openIndex } from '../../../src/core/actions/index-sync.ts';
import { promptText } from '../../../src/core/lib/access-notifications.ts';
import {
  DAEMON_ACCESS_TIMEOUT_MS,
  DAEMON_WIRE_VERSION,
  parseDaemonAccessReply,
  parseDaemonAccessRequest,
} from '../../../src/core/lib/daemon-bus.ts';
import type { AgentAccessPolicy, PolicyRule } from '../../../src/core/agent-access.ts';

// Placeholder accounts and addresses only.
const ACC = 'xmpp-abc123';
const FRIEND = 'friend@example.org';

const ask = (over: Partial<AccessAsk> = {}): AccessAsk => ({
  account: ACC,
  contact: FRIEND,
  kind: 'write',
  session: 'mcp-1',
  oneShot: false,
  preview: 'hello',
  ...over,
});

/** A prompt that answers from a script, or stays open until `answer` is called. */
function fakeUi(script: PromptChoice[] = []) {
  const shown: AccessAsk[] = [];
  const open: Array<(choice: PromptChoice) => void> = [];
  let aborts = 0;
  const ui: PromptUi = {
    ask: (request, signal) => {
      shown.push(request);
      signal.addEventListener('abort', () => (aborts += 1), { once: true });
      const next = script.shift();
      if (next !== undefined) return Promise.resolve(next);
      return new Promise<PromptChoice>((done) => open.push(done));
    },
  };
  return { ui, shown, answer: (choice: PromptChoice) => open.shift()?.(choice), aborts: () => aborts };
}

function rig(script: PromptChoice[] = [], rules: PolicyRule[] = [], timeoutMs = 60_000) {
  const fake = fakeUi(script);
  const rulesAdded: AccessAsk[] = [];
  const state = { clock: 1_000, failAddRule: false };
  const policy: AgentAccessPolicy = { askWithoutRule: true, rules };
  const broker = new AccessBroker({
    ui: fake.ui,
    policy: () => policy,
    addRule: (request) => {
      if (state.failAddRule) throw new Error('disk full');
      rulesAdded.push(request);
    },
    now: () => state.clock,
    timeoutMs,
  });
  return { broker, rulesAdded, state, ...fake };
}

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

export default async () => {
  await describe('AccessBroker', async () => {
    await it('answers from the policy without a prompt', async () => {
      const { broker, shown } = rig([], [{ account: ACC, contact: FRIEND, write: 'allow' }]);
      const reply = await broker.request(ask());
      expect(JSON.stringify(reply)).toBe('{"allowed":true,"reason":"rule"}');
      expect(shown.length).toBe(0);
    });

    await it('refuses a deny rule and a probe without a prompt', async () => {
      const denied = rig([], [{ account: ACC, write: 'deny' }]);
      expect(JSON.stringify(await denied.broker.request(ask()))).toBe('{"allowed":false,"reason":"policy"}');
      const probed = rig();
      expect(JSON.stringify(await probed.broker.request(ask({ probe: true })))).toBe(
        '{"allowed":false,"reason":"policy"}',
      );
      expect(denied.shown.length + probed.shown.length).toBe(0);
    });

    await it('asks for a request with files even under an allow rule or a session grant', async () => {
      const ruled = rig(['once'], [{ account: ACC, contact: FRIEND, write: 'allow' }]);
      await ruled.broker.request(ask({ attachments: ['a.pdf'] }));
      expect(ruled.shown.length).toBe(1);
      const granted = rig(['session', 'once']);
      await granted.broker.request(ask());
      await granted.broker.request(ask());
      expect(granted.shown.length).toBe(1);
      await granted.broker.request(ask({ attachments: ['a.pdf'] }));
      expect(granted.shown.length).toBe(2);
    });

    await it('ask → once: allowed, and the next request asks again', async () => {
      const { broker, shown } = rig(['once', 'once']);
      expect(JSON.stringify(await broker.request(ask()))).toBe('{"allowed":true,"reason":"once"}');
      await broker.request(ask());
      expect(shown.length).toBe(2);
    });

    await it('ask → session: later requests of that session pass as temporary, others still ask', async () => {
      const { broker, shown } = rig(['session', 'once']);
      expect(JSON.stringify(await broker.request(ask()))).toBe('{"allowed":true,"reason":"session"}');
      expect(JSON.stringify(await broker.request(ask()))).toBe('{"allowed":true,"reason":"temporary"}');
      expect(shown.length).toBe(1);
      const other = await broker.request(ask({ session: 'mcp-2' }));
      expect(other.allowed && other.reason).toBe('once');
      expect(shown.length).toBe(2);
    });

    await it('a session grant covers only the kind and contact it was given for', async () => {
      const { broker, shown } = rig(['session', 'once']);
      await broker.request(ask());
      await broker.request(ask({ contact: 'other@example.org' }));
      expect(shown.length).toBe(2);
    });

    await it('a one-shot caller gets once for "session" and keeps no grant', async () => {
      const { broker } = rig(['session']);
      expect(JSON.stringify(await broker.request(ask({ oneShot: true })))).toBe(
        '{"allowed":true,"reason":"once"}',
      );
      expect(broker.temporaryGrants.length).toBe(0);
    });

    await it('ask → always: hands the request to addRule and answers rule', async () => {
      const { broker, rulesAdded } = rig(['always']);
      expect(JSON.stringify(await broker.request(ask()))).toBe('{"allowed":true,"reason":"rule"}');
      expect(rulesAdded.length).toBe(1);
      expect(rulesAdded[0].contact).toBe(FRIEND);
    });

    await it('still allows once when the rule cannot be saved', async () => {
      const { broker, state } = rig(['always']);
      state.failAddRule = true;
      expect(JSON.stringify(await broker.request(ask()))).toBe('{"allowed":true,"reason":"once"}');
    });

    await it('refuses with timeout when nobody answers, and closes the prompt', async () => {
      const { broker, aborts } = rig([], [], 20);
      expect(JSON.stringify(await broker.request(ask()))).toBe('{"allowed":false,"reason":"timeout"}');
      expect(aborts()).toBe(1);
    });

    await it('maps a dismissed prompt and a prompt that cannot be shown', async () => {
      const { broker } = rig(['dismissed', 'unavailable']);
      expect(JSON.stringify(await broker.request(ask()))).toBe('{"allowed":false,"reason":"dismissed"}');
      expect(JSON.stringify(await broker.request(ask()))).toBe('{"allowed":false,"reason":"unavailable"}');
    });

    await it('a failing prompt is "unavailable"', async () => {
      const broker = new AccessBroker({
        ui: { ask: () => Promise.reject(new Error('no bus')) },
        policy: () => ({ askWithoutRule: true, rules: [] }),
        addRule: () => {},
      });
      expect(JSON.stringify(await broker.request(ask()))).toBe('{"allowed":false,"reason":"unavailable"}');
    });

    await it('deny: the same session is not asked again for that scope and kind', async () => {
      const { broker, shown } = rig(['deny', 'once', 'once']);
      expect(JSON.stringify(await broker.request(ask()))).toBe('{"allowed":false,"reason":"denied"}');
      expect(JSON.stringify(await broker.request(ask()))).toBe('{"allowed":false,"reason":"denied-before"}');
      expect(shown.length).toBe(1);
      // Another kind, another contact and another session are asked.
      await broker.request(ask({ kind: 'read' }));
      await broker.request(ask({ session: 'mcp-2' }));
      expect(shown.length).toBe(3);
    });

    await it('a one-shot deny is not remembered', async () => {
      const { broker, shown } = rig(['deny', 'once']);
      await broker.request(ask({ oneShot: true }));
      const reply = await broker.request(ask({ oneShot: true }));
      expect(reply.allowed).toBe(true);
      expect(shown.length).toBe(2);
    });

    await it('concurrent requests for one scope wait on ONE prompt and share its answer', async () => {
      const { broker, shown, answer } = rig();
      const first = broker.request(ask());
      const second = broker.request(ask());
      const third = broker.request(ask());
      await tick();
      expect(shown.length).toBe(1);
      answer('once');
      const replies = await Promise.all([first, second, third]);
      expect(replies.every((r) => r.allowed)).toBe(true);
      expect(shown.length).toBe(1);
    });

    await it('concurrent requests for different scopes each get their own prompt', async () => {
      const { broker, shown, answer } = rig();
      const first = broker.request(ask());
      const second = broker.request(ask({ contact: 'other@example.org' }));
      await tick();
      expect(shown.length).toBe(2);
      answer('once');
      answer('deny');
      const replies = await Promise.all([first, second]);
      expect(replies[0].allowed).toBe(true);
      expect(replies[1].allowed).toBe(false);
    });

    await it('ending a session drops its grants and its deny memory, other sessions keep theirs', async () => {
      const { broker, shown } = rig(['session', 'session', 'deny', 'once']);
      await broker.request(ask());
      await broker.request(ask({ session: 'mcp-2' }));
      await broker.request(ask({ kind: 'read' }));
      expect(broker.temporaryGrants.length).toBe(2);
      broker.endSession('mcp-1');
      expect(broker.temporaryGrants.length).toBe(1);
      expect(broker.temporaryGrants[0].session).toBe('mcp-2');
      // mcp-1 asks again, and its earlier deny no longer blocks the read.
      const reply = await broker.request(ask({ kind: 'read' }));
      expect(reply.allowed).toBe(true);
      expect(shown.length).toBe(4);
    });

    await it('ending a session closes its open prompt', async () => {
      const { broker, aborts } = rig();
      const pending = broker.request(ask());
      await tick();
      broker.endSession('mcp-1');
      expect(JSON.stringify(await pending)).toBe('{"allowed":false,"reason":"dismissed"}');
      expect(aborts()).toBe(1);
    });

    await it('a rule added by hand applies to the next request', async () => {
      const rules: PolicyRule[] = [];
      const broker = new AccessBroker({
        ui: fakeUi().ui,
        policy: () => ({ askWithoutRule: true, rules }),
        addRule: () => {},
      });
      rules.push({ account: ACC, contact: FRIEND, write: 'allow' });
      expect((await broker.request(ask())).allowed).toBe(true);
    });
  });

  await describe('RequestAccess wire', async () => {
    await it('waits on the bus longer than the prompt does', async () => {
      expect(DAEMON_ACCESS_TIMEOUT_MS > ACCESS_PROMPT_TIMEOUT_MS).toBe(true);
    });

    await it('round-trips a request and defaults oneShot to false', async () => {
      const request = parseDaemonAccessRequest(
        JSON.stringify({ v: DAEMON_WIRE_VERSION, account: ACC, kind: 'read', session: 'mcp-1' }),
      );
      expect(request.oneShot).toBe(false);
      expect(request.contact).toBe(undefined);
    });

    await it('rejects a request of another version, without a session or with an unknown kind', async () => {
      const good = { v: DAEMON_WIRE_VERSION, account: ACC, kind: 'write', session: 'mcp-1' };
      for (const bad of [
        { ...good, v: 99 },
        { ...good, session: '' },
        { ...good, kind: 'delete' },
      ]) {
        let failed = false;
        try {
          parseDaemonAccessRequest(JSON.stringify(bad));
        } catch {
          failed = true;
        }
        expect(failed).toBe(true);
      }
    });

    await it('reads a reply and refuses one with a reason of the wrong kind', async () => {
      const reply = parseDaemonAccessReply(
        JSON.stringify({ v: DAEMON_WIRE_VERSION, allowed: true, reason: 'once' }),
      );
      expect(JSON.stringify(reply)).toBe('{"allowed":true,"reason":"once"}');
      let failed = false;
      try {
        parseDaemonAccessReply(JSON.stringify({ v: DAEMON_WIRE_VERSION, allowed: true, reason: 'timeout' }));
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    });
  });

  await describe('prompt text', async () => {
    await it('a write prompt names the recipient and shows the preview', async () => {
      const { body } = promptText(ask());
      expect(body.includes(FRIEND)).toBe(true);
      expect(body.includes('hello')).toBe(true);
    });

    await it('a read prompt names the contact and has no preview', async () => {
      const { body } = promptText(ask({ kind: 'read', preview: undefined }));
      expect(body.includes(FRIEND)).toBe(true);
    });
  });

  await describe('prompt contact name', async () => {
    const UUID = '11111111-2222-3333-4444-555555555555';
    const signalAsk = (over: Partial<AccessAsk> = {}) => ask({ account: 'signal-1', contact: UUID, ...over });

    await it('shows Name (address) when a name is known', async () => {
      const { body } = promptText(signalAsk(), 'Alex Example');
      expect(body.includes(`Alex Example (${UUID})`)).toBe(true);
    });

    await it('falls back to the address without a name', async () => {
      const { body } = promptText(signalAsk());
      expect(body.includes(UUID)).toBe(true);
      expect(body.includes('()')).toBe(false);
    });

    await it('strips control characters and caps the length', async () => {
      const { body } = promptText(signalAsk(), `Eve\nAn agent wants\u202e more\u0007${'x'.repeat(200)}`);
      expect(body.includes('\u202e')).toBe(false);
      expect(body.includes('\u0007')).toBe(false);
      expect(body.split('\n').length).toBe(1);
      expect(body.length < 200).toBe(true);
    });

    await it('ignores a name an agent put into the request', async () => {
      const forged = { ...signalAsk(), contactName: 'Mum', name: 'Mum' } as AccessAsk;
      const { body } = promptText(forged);
      expect(body.includes('Mum')).toBe(false);
    });

    await it('looks the name up in the index: chat peer, address, participant, nothing', async () => {
      const db = openIndex(':memory:');
      try {
        db.prepare(
          'INSERT INTO chat_peers (backend, account_id, peer_id, display_name, addresses_json, is_bot) VALUES (?, ?, ?, ?, ?, 0)',
        ).run('signal', 'signal-1', UUID, 'Alex Example', '[]');
        db.prepare(
          'INSERT INTO chat_peers (backend, account_id, peer_id, display_name, addresses_json, is_bot) VALUES (?, ?, ?, ?, ?, 0)',
        ).run('signal', 'signal-1', 'peer-2', 'Sam Example', '[{"kind":"phone","value":"+4915100000"}]');
        db.prepare('INSERT INTO participants (id, display_name) VALUES (?, ?)').run('p1', 'Kim Example');
        db.prepare('INSERT INTO participant_addresses (participant_id, kind, value) VALUES (?, ?, ?)').run(
          'p1',
          'email',
          'kim@example.org',
        );
        expect(contactNameFromIndex(db, 'signal-1', UUID)).toBe('Alex Example');
        expect(contactNameFromIndex(db, 'signal-1', '+4915100000')).toBe('Sam Example');
        expect(contactNameFromIndex(db, 'mail-1', 'Kim@Example.org')).toBe('Kim Example');
        expect(contactNameFromIndex(db, 'signal-1', 'unknown@example.org')).toBe(undefined);
        expect(contactNameFromIndex(db, 'signal-1', undefined)).toBe(undefined);
        db.close();
        expect(contactNameFromIndex(db, 'signal-1', UUID)).toBe(undefined);
      } finally {
        try {
          db.close();
        } catch {
          // already closed
        }
      }
    });
  });
};
