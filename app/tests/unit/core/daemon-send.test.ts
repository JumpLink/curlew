import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  BackendAccount,
  BackendManifest,
  DeliverySession,
  MessageSender,
  SendPermit,
  SendingMessage,
  SentMessage,
} from '@curlew/protocol';
import { PLUGIN_API_VERSION } from '@curlew/protocol';
import { getConversation, takeReceiveLease } from '@curlew/store';
import { createDaemonSendHandler, sessionKey } from '../../../src/core/actions/daemon.ts';
import { openIndex } from '../../../src/core/actions/index-sync.ts';
import { sendMessage } from '../../../src/core/actions/send.ts';
import { DAEMON_WIRE_VERSION, type DaemonSendRequest } from '../../../src/core/lib/daemon-bus.ts';
import type { DaemonSendClient } from '../../../src/core/lib/daemon-send-client.ts';

/**
 * A send on a backend that shares its protocol state with its receive path, routed through the
 * daemon (ADR 0004, amendment 2026-10-30, daemon send).
 *
 * Two halves, both without a bus: the CALLER's routing (`sendMessage` against an injected
 * `DaemonSendClient`) and the DAEMON's handler (`createDaemonSendHandler` against a scripted
 * session). The transport between them is Gio's, and the test suite deliberately runs with
 * `DBUS_SESSION_BUS_ADDRESS` pointing nowhere — the round trip over a real bus is the hand-run
 * `tests/integration/daemon-send-dbus.ts`.
 *
 * What matters here and is asserted: a send reaches the daemon when one holds the account; it
 * takes the lease itself when none does; the message is written to the log and the index exactly
 * ONCE whichever process reached the network; and the daemon refuses a send its own grants do not
 * name, however the caller asked.
 *
 * All data is synthetic.
 */

/**
 * Named `signal` only because a grant may name a capability the config knows, and `signal.send`
 * is the real one for a real shared-state backend. Nothing else about this backend is Signal's: it
 * is injected into `sendMessage`, so the registry never builds the real one, and no key, store or
 * connection of Signal's is involved.
 */
const BACKEND = 'signal';
const ACCOUNT = 'shared-1';
const PEER = '+491510000002';
const CAPABILITY = `${BACKEND}.send`;
const ACCOUNT_INFO: BackendAccount = { id: ACCOUNT, identity: ACCOUNT, provider: 'Fake' };
const GRANTS = [{ capability: CAPABILITY, target: `${ACCOUNT}/${PEER}` }];

const MANIFEST: BackendManifest = {
  name: BACKEND,
  displayName: 'Fake shared-state backend',
  pluginApi: PLUGIN_API_VERSION,
  capabilities: {
    edits: false,
    reactions: false,
    threads: false,
    readReceipts: false,
    groups: false,
    e2ee: true,
    subject: false,
    folders: false,
    attachments: false,
  },
  syncModel: 'delivery-only',
  native: false,
  addressKinds: ['phone'],
  terms: null,
  // The whole reason this file exists: a send cannot run beside the receive path.
  sendSharesReceiveState: true,
};

/** A sender that records what it was given and never touches a network. */
class FakeSender implements MessageSender {
  readonly features = { markdown: false };
  readonly sent: SendingMessage[] = [];
  closed = 0;

  constructor(
    private readonly tag: string,
    private readonly fail?: string,
  ) {}

  async send(message: SendingMessage): Promise<SentMessage> {
    if (this.fail !== undefined) throw new Error(this.fail);
    this.sent.push(message);
    return {
      target: message.to,
      id: `${this.tag}-${this.sent.length}`,
      sentAt: '2026-10-30T12:00:00.000Z',
      chatRemoteId: message.to,
      encrypted: true,
    };
  }

  async close(): Promise<void> {
    this.closed++;
  }
}

/** The caller's backend: it can open a sender of its own, which is the direct path. */
function callerBackend(sender: FakeSender, openFailure?: string) {
  const opened: SendPermit[] = [];
  return {
    opened,
    backend: {
      manifest: MANIFEST,
      kind: 'delivery' as const,
      listAccounts: async (): Promise<BackendAccount[]> => [ACCOUNT_INFO],
      openSender: async (_id: string, permit: SendPermit): Promise<MessageSender> => {
        if (openFailure !== undefined) throw new Error(openFailure);
        opened.push(permit);
        return sender;
      },
    },
  };
}

/** A client that answers whatever the case scripts, and records what it was asked. */
function fakeClient(reply: Awaited<ReturnType<DaemonSendClient['send']>>): {
  client: DaemonSendClient;
  asked: DaemonSendRequest[];
} {
  const asked: DaemonSendRequest[] = [];
  return {
    asked,
    client: {
      send: async (request) => {
        asked.push(request);
        return reply;
      },
    },
  };
}

interface World {
  dir: string;
  dbPath: string;
  configPath: string;
  writeLogPath: string;
  /** Every line the write log holds. */
  logLines(): string[];
  /** How many rows the index has for this conversation. */
  indexed(conversationId: string): number;
}

async function withWorld(config: unknown, body: (world: World) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-daemon-send-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const writeLogPath = join(dir, 'write.log');
  try {
    await body({
      dir,
      dbPath: join(dir, 'index.db'),
      configPath,
      writeLogPath,
      logLines: () => {
        let text: string;
        try {
          text = readFileSync(writeLogPath, 'utf8');
        } catch {
          return [];
        }
        return text.split('\n').filter((l) => l.trim() !== '');
      },
      indexed: (conversationId) => {
        const db = openIndex(join(dir, 'index.db'));
        try {
          return getConversation(db, conversationId, { includeBodies: true })?.messages.length ?? 0;
        } finally {
          db.close();
        }
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One step shaped the way the daemon puts it on the wire. */
const step = (id: string, body: string) => ({
  sent: {
    target: PEER,
    id,
    sentAt: '2026-10-30T12:00:00.000Z',
    chatRemoteId: PEER,
    encrypted: true,
  },
  body,
});

/** A session the daemon is holding, with or without a way to send on it. */
function heldSession(
  sender?: MessageSender,
  openFailure?: string,
): DeliverySession & { permits: SendPermit[] } {
  const permits: SendPermit[] = [];
  const session: DeliverySession & { permits: SendPermit[] } = {
    permits,
    nextBatch: async () => null,
    outcome: () => ({ caughtUp: true, error: null }),
    close: async () => {},
    ...(sender === undefined && openFailure === undefined
      ? {}
      : {
          openSender: async (permit: SendPermit): Promise<MessageSender> => {
            permits.push(permit);
            if (openFailure !== undefined) throw new Error(openFailure);
            return sender as MessageSender;
          },
        }),
  };
  return session;
}

export default async () => {
  await describe('a send on a shared-state backend asks the daemon first', async () => {
    await it('uses what the daemon sent, opens no connection of its own, and records it once', async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        const sender = new FakeSender('own');
        const { backend, opened } = callerBackend(sender);
        const { client, asked } = fakeClient({
          v: DAEMON_WIRE_VERSION,
          kind: 'sent',
          markdown: false,
          steps: [step('daemon-1', 'hi')],
        });
        const out = await sendMessage({
          accountId: ACCOUNT,
          to: PEER,
          text: 'hi',
          frontend: 'cli',
          dbPath: world.dbPath,
          configPath: world.configPath,
          writeLogPath: world.writeLogPath,
          backend: backend as never,
          daemon: client,
        });
        // The daemon's message is the one that is reported, logged and indexed.
        expect(out.originId).toBe('daemon-1');
        expect(asked.length).toBe(1);
        expect(asked[0].capability).toBe(CAPABILITY);
        expect(asked[0].backend).toBe(BACKEND);
        expect(asked[0].account).toBe(ACCOUNT);
        // Nothing of ours was opened: the daemon's connection is the only one that sent.
        expect(opened.length).toBe(0);
        expect(sender.sent.length).toBe(0);
        // Exactly once each, and by THIS process — the daemon writes neither.
        const lines = world.logLines();
        expect(lines.length).toBe(1);
        expect(JSON.parse(lines[0]).id).toBe('daemon-1');
        expect(out.messageId !== null).toBe(true);
        expect(world.indexed(out.conversationId as string)).toBe(1);
      });
    });

    await it('sends every part the daemon reported, and logs one line per part', async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        const { backend } = callerBackend(new FakeSender('own'));
        const { client } = fakeClient({
          v: DAEMON_WIRE_VERSION,
          kind: 'sent',
          markdown: true,
          steps: [step('daemon-1', 'one'), step('daemon-2', 'two')],
        });
        const out = await sendMessage({
          accountId: ACCOUNT,
          to: PEER,
          text: 'one\n\ntwo',
          format: 'markdown',
          frontend: 'cli',
          dbPath: world.dbPath,
          configPath: world.configPath,
          writeLogPath: world.writeLogPath,
          backend: backend as never,
          daemon: client,
        });
        expect(out.parts).toBe(2);
        expect(out.originIds?.join()).toBe('daemon-1,daemon-2');
        expect(world.logLines().length).toBe(2);
        expect(world.indexed(out.conversationId as string)).toBe(2);
      });
    });

    await it('takes the lease and sends itself when no daemon answers', async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        const sender = new FakeSender('own');
        const { backend, opened } = callerBackend(sender);
        const { client, asked } = fakeClient(null);
        const out = await sendMessage({
          accountId: ACCOUNT,
          to: PEER,
          text: 'hi',
          frontend: 'cli',
          dbPath: world.dbPath,
          configPath: world.configPath,
          writeLogPath: world.writeLogPath,
          backend: backend as never,
          daemon: client,
        });
        expect(asked.length).toBe(1);
        expect(opened.length).toBe(1);
        expect(opened[0].addresses.join()).toBe(PEER);
        expect(sender.sent.length).toBe(1);
        expect(sender.closed).toBe(1);
        expect(out.originId).toBe('own-1');
        expect(world.logLines().length).toBe(1);
      });
    });

    await it('falls back to its own path when the daemon does not hold the account', async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        const sender = new FakeSender('own');
        const { backend, opened } = callerBackend(sender);
        const { client } = fakeClient({ v: DAEMON_WIRE_VERSION, kind: 'not-followed' });
        const out = await sendMessage({
          accountId: ACCOUNT,
          to: PEER,
          text: 'hi',
          frontend: 'cli',
          dbPath: world.dbPath,
          configPath: world.configPath,
          writeLogPath: world.writeLogPath,
          backend: backend as never,
          daemon: client,
        });
        expect(opened.length).toBe(1);
        expect(out.originId).toBe('own-1');
      });
    });

    await it("raises the daemon's refusal as it is, and sends nothing itself", async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        const sender = new FakeSender('own');
        const { backend, opened } = callerBackend(sender);
        const { client } = fakeClient({
          v: DAEMON_WIRE_VERSION,
          kind: 'refused',
          message: 'the daemon says no',
        });
        await expect(
          sendMessage({
            accountId: ACCOUNT,
            to: PEER,
            text: 'hi',
            frontend: 'cli',
            dbPath: world.dbPath,
            configPath: world.configPath,
            writeLogPath: world.writeLogPath,
            backend: backend as never,
            daemon: client,
          }),
        ).rejects.toThrow(/the daemon says no/);
        expect(opened.length).toBe(0);
        expect(sender.sent.length).toBe(0);
        expect(world.logLines().length).toBe(0);
      });
    });

    await it('still refuses when a holder has the lease and did not take the send', async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        // The daemon holds the account but could not be reached over the bus: the lease is the
        // only thing left to go by, and it says someone else is receiving.
        const db = openIndex(world.dbPath);
        try {
          expect(takeReceiveLease(db, BACKEND, ACCOUNT, 'pid-other-daemon', new Date()).acquired).toBe(true);
        } finally {
          db.close();
        }
        const sender = new FakeSender('own');
        const { backend, opened } = callerBackend(sender);
        const { client } = fakeClient(null);
        await expect(
          sendMessage({
            accountId: ACCOUNT,
            to: PEER,
            text: 'hi',
            frontend: 'cli',
            dbPath: world.dbPath,
            configPath: world.configPath,
            writeLogPath: world.writeLogPath,
            backend: backend as never,
            daemon: client,
          }),
        ).rejects.toThrow(/did not take the send over/);
        expect(opened.length).toBe(0);
        expect(world.logLines().length).toBe(0);
      });
    });
  });

  await describe('the daemon answering a send', async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const request = (over: Partial<DaemonSendRequest> = {}): DaemonSendRequest => ({
      v: DAEMON_WIRE_VERSION,
      backend: BACKEND,
      account: ACCOUNT,
      capability: CAPABILITY,
      to: PEER,
      text: 'hi',
      ...over,
    });
    const handlerFor = (
      sessions: Map<string, DeliverySession>,
      grants: Array<{ capability: string; target: string }> = GRANTS,
      onConfig?: () => void,
    ) =>
      createDaemonSendHandler({
        sessions,
        config: () => {
          onConfig?.();
          return { grants: grants as never };
        },
        log,
      });

    await it('sends on the session it is holding and closes only the sender', async () => {
      const sender = new FakeSender('daemon');
      const session = heldSession(sender);
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), session]]);
      const reply = await handlerFor(sessions)(request());
      expect(reply.kind).toBe('sent');
      if (reply.kind !== 'sent') return;
      expect(reply.steps.length).toBe(1);
      expect(reply.steps[0].sent.id).toBe('daemon-1');
      expect(reply.steps[0].body).toBe('hi');
      expect(reply.markdown).toBe(false);
      expect(sender.sent[0].to).toBe(PEER);
      // The send's own handle is closed; the session the daemon receives on is not.
      expect(sender.closed).toBe(1);
      expect(session.permits[0].addresses.join()).toBe(PEER);
    });

    await it('is not-followed for an account it does not hold', async () => {
      const reply = await handlerFor(new Map())(request());
      expect(reply.kind).toBe('not-followed');
    });

    await it('is not-followed when the session cannot send on itself', async () => {
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession()]]);
      const reply = await handlerFor(sessions)(request());
      expect(reply.kind).toBe('not-followed');
    });

    await it('is not-followed for an account of another backend with the same name', async () => {
      const sessions = new Map([[sessionKey('other', ACCOUNT), heldSession(new FakeSender('daemon'))]]);
      const reply = await handlerFor(sessions)(request());
      expect(reply.kind).toBe('not-followed');
    });

    await it('refuses a send its own grants do not name, however the caller asked', async () => {
      const sender = new FakeSender('daemon');
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(sender)]]);
      // A caller that checked nothing, or whose grant was withdrawn since: the daemon's own
      // config is the one that decides, and it is read for this very call.
      for (const [grants, asked] of [
        [[], request()],
        [GRANTS, request({ to: 'other@example.org' })],
        [[{ capability: CAPABILITY, target: `other-account/${PEER}` }], request()],
      ] as const) {
        const reply = await handlerFor(sessions, [...grants])(asked);
        expect(reply.kind).toBe('refused');
        expect(reply.kind === 'refused' && reply.message.length > 0).toBe(true);
      }
      expect(sender.sent.length).toBe(0);
    });

    await it('refuses a capability that is not the one this backend sends under', async () => {
      const sender = new FakeSender('daemon');
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(sender)]]);
      // A grant for another backend's capability on the same pair must not open this one's
      // session — the pair is checked together with the backend, never alone.
      const reply = await handlerFor(sessions, [{ capability: 'xmpp.send', target: `${ACCOUNT}/${PEER}` }])(
        request({ capability: 'xmpp.send' }),
      );
      expect(reply.kind).toBe('refused');
      expect(sender.sent.length).toBe(0);
    });

    await it('reads the grants again for every send', async () => {
      let reads = 0;
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(new FakeSender('daemon'))]]);
      const handler = handlerFor(sessions, GRANTS, () => {
        reads++;
      });
      await handler(request());
      await handler(request());
      expect(reads).toBe(2);
    });

    await it('says nothing was sent when the sender cannot even be opened', async () => {
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(undefined, 'no ratchet')]]);
      const reply = await handlerFor(sessions)(request());
      expect(reply.kind).toBe('failed');
      expect(reply.kind === 'failed' && /nothing was sent/.test(reply.message)).toBe(true);
    });

    await it('answers failed when the send itself does not complete, and still closes the sender', async () => {
      const sender = new FakeSender('daemon', 'the network said no');
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(sender)]]);
      const reply = await handlerFor(sessions)(request());
      expect(reply.kind).toBe('failed');
      expect(reply.kind === 'failed' && /the network said no/.test(reply.message)).toBe(true);
      expect(sender.closed).toBe(1);
    });

    await it('never logs the message text', async () => {
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(new FakeSender('daemon'))]]);
      await handlerFor(sessions)(request({ text: 'geheim, aber synthetisch' }));
      expect(lines.length > 0).toBe(true);
      expect(lines.some((l) => l.includes('geheim'))).toBe(false);
      expect(lines.some((l) => l.includes(PEER))).toBe(false);
    });
  });
};
