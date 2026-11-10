import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type {
  BackendAccount,
  BackendManifest,
  DeliverySession,
  MessageSender,
  SendPermit,
  SendingDeletion,
  SendingEdit,
  SendingMessage,
  SendingReaction,
  SentMessage,
} from '@curlew/protocol';
import { PLUGIN_API_VERSION } from '@curlew/protocol';
import { getConversation, takeReceiveLease } from '@curlew/store';
import { createDaemonSendHandler, sessionKey } from '../../../src/core/actions/daemon.ts';
import { deleteMessage } from '../../../src/core/actions/delete.ts';
import { editMessage } from '../../../src/core/actions/edit.ts';
import { openIndex } from '../../../src/core/actions/index-sync.ts';
import { reactToMessage } from '../../../src/core/actions/react.ts';
import { sendMessage } from '../../../src/core/actions/send.ts';
import {
  DAEMON_WIRE_VERSION,
  type DaemonSendRequest,
  parseDaemonSendRequest,
} from '../../../src/core/lib/daemon-bus.ts';
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
 * ONCE whichever process reached the network; and the daemon checks no grant (ADR 0008), because
 * grants restrict the agent frontends and this is the person's send service.
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
    attachmentsRead: false,
    replies: false,
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
  readonly features = {
    markdown: false,
    attachments: false,
    replies: false,
    reactions: false,
    edits: false,
    deletes: false,
  };
  readonly sent: SendingMessage[] = [];
  readonly reacted: SendingReaction[] = [];
  readonly edited: SendingEdit[] = [];
  readonly deleted: SendingDeletion[] = [];
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
      ...(message.attachments === undefined
        ? {}
        : { attachments: message.attachments.map((a) => ({ filename: basename(a.path), size: 1 })) }),
    };
  }

  async react(reaction: SendingReaction): Promise<void> {
    if (this.fail !== undefined) throw new Error(this.fail);
    this.reacted.push(reaction);
  }

  async edit(edit: SendingEdit): Promise<void> {
    if (this.fail !== undefined) throw new Error(this.fail);
    this.edited.push(edit);
  }

  async delete(deletion: SendingDeletion): Promise<void> {
    if (this.fail !== undefined) throw new Error(this.fail);
    this.deleted.push(deletion);
  }

  async close(): Promise<void> {
    this.closed++;
  }
}

/** The caller's backend: it can open a sender of its own, which is the direct path. */
function callerBackend(sender: FakeSender, openFailure?: string, manifest: BackendManifest = MANIFEST) {
  const opened: SendPermit[] = [];
  return {
    opened,
    backend: {
      manifest,
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
      fetchAttachment: async () => null,
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

    await it('sends from an enabled account without any grant (ADR 0008)', async () => {
      await withWorld({}, async (world) => {
        const sender = new FakeSender('own');
        const { backend, opened } = callerBackend(sender);
        const { client } = fakeClient(null);
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
        expect(out.originId).toBe('own-1');
        expect(opened[0].addresses.join()).toBe(PEER);
        // Every write still leaves a line (ADR 0008 §4).
        expect(world.logLines().length).toBe(1);
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

  await describe('reacting to a message', async () => {
    const REACTING: BackendManifest = {
      ...MANIFEST,
      capabilities: { ...MANIFEST.capabilities, reactions: true },
    };
    const target = { remoteId: 'm1', fromSelf: true };
    const react = (world: World, backend: unknown, daemon: DaemonSendClient, emoji: string | null = '👍') =>
      reactToMessage({
        accountId: ACCOUNT,
        to: PEER,
        target,
        emoji,
        frontend: 'window',
        dbPath: world.dbPath,
        configPath: world.configPath,
        writeLogPath: world.writeLogPath,
        backend: backend as never,
        daemon,
      });

    await it('goes to the daemon first and opens no sender of its own', async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        const sender = new FakeSender('own');
        sender.features.reactions = true;
        const { backend, opened } = callerBackend(sender, undefined, REACTING);
        const { client, asked } = fakeClient({
          v: DAEMON_WIRE_VERSION,
          kind: 'sent',
          markdown: false,
          steps: [],
        });
        await react(world, backend, client);
        expect(asked.length).toBe(1);
        expect(asked[0].reaction).toStrictEqual({ target, emoji: '👍' });
        expect(asked[0].text === undefined).toBe(true);
        expect(opened.length).toBe(0);
        expect(world.logLines().length).toBe(1);
        expect(world.logLines()[0]).toMatch(/reaction:m1/);
      });
    });

    await it('falls back to its own sender when no daemon holds the account', async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        const sender = new FakeSender('own');
        sender.features.reactions = true;
        const { backend, opened } = callerBackend(sender, undefined, REACTING);
        const { client } = fakeClient(null);
        await react(world, backend, client, null);
        expect(opened.length).toBe(1);
        expect(sender.reacted).toStrictEqual([{ to: PEER, target, emoji: null }]);
        expect(sender.closed).toBe(1);
        expect(world.logLines().length).toBe(1);
      });
    });

    await it('refuses a backend whose manifest cannot send a reaction, and logs nothing', async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        const sender = new FakeSender('own');
        const { backend, opened } = callerBackend(sender);
        const { client, asked } = fakeClient(null);
        await expect(react(world, backend, client)).rejects.toThrow(/cannot send a reaction/);
        expect(asked.length).toBe(0);
        expect(opened.length).toBe(0);
        expect(world.logLines().length).toBe(0);
      });
    });
  });

  await describe('editing a message', async () => {
    const target = { remoteId: 'm1', fromSelf: true };
    const edit = (world: World, backend: unknown, daemon: DaemonSendClient, text: string = 'fixed') =>
      editMessage({
        accountId: ACCOUNT,
        to: PEER,
        target,
        text,
        frontend: 'window',
        dbPath: world.dbPath,
        configPath: world.configPath,
        writeLogPath: world.writeLogPath,
        backend: backend as never,
        daemon,
      });

    await it('goes to the daemon first and opens no sender of its own', async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        const sender = new FakeSender('own');
        sender.features.edits = true;
        const { backend, opened } = callerBackend(sender);
        const { client, asked } = fakeClient({
          v: DAEMON_WIRE_VERSION,
          kind: 'sent',
          markdown: false,
          steps: [],
        });
        await edit(world, backend, client);
        expect(asked.length).toBe(1);
        expect(asked[0].edit).toStrictEqual({ target, text: 'fixed' });
        expect(asked[0].text === undefined).toBe(true);
        expect(opened.length).toBe(0);
        expect(world.logLines().length).toBe(1);
        expect(world.logLines()[0]).toMatch(/edit:m1/);
      });
    });

    await it('falls back to its own sender when no daemon holds the account', async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        const sender = new FakeSender('own');
        sender.features.edits = true;
        const { backend, opened } = callerBackend(sender);
        const { client } = fakeClient(null);
        await edit(world, backend, client);
        expect(opened.length).toBe(1);
        expect(sender.edited).toStrictEqual([{ to: PEER, target, text: 'fixed' }]);
        expect(sender.closed).toBe(1);
        expect(world.logLines().length).toBe(1);
      });
    });

    await it('refuses a target that is not the persons own, and logs nothing', async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        const sender = new FakeSender('own');
        sender.features.edits = true;
        const { backend, opened } = callerBackend(sender);
        const { client, asked } = fakeClient(null);
        await expect(
          editMessage({
            accountId: ACCOUNT,
            to: PEER,
            target: { remoteId: 'm1', fromSelf: false },
            text: 'fixed',
            frontend: 'window',
            dbPath: world.dbPath,
            configPath: world.configPath,
            writeLogPath: world.writeLogPath,
            backend: backend as never,
            daemon: client,
          }),
        ).rejects.toThrow(/only your own messages can be edited/);
        // The daemon is asked first; only after it says it does not hold the account does the
        // direct path open a sender and refuse.
        expect(asked.length).toBe(1);
        expect(opened.length).toBe(1);
        expect(world.logLines().length).toBe(0);
      });
    });

    await it('refuses a sender that cannot edit, and logs nothing', async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        const sender = new FakeSender('own');
        const { backend, opened } = callerBackend(sender);
        const { client, asked } = fakeClient(null);
        await expect(edit(world, backend, client)).rejects.toThrow(/cannot edit a message/);
        expect(asked.length).toBe(1);
        expect(opened.length).toBe(1);
        expect(world.logLines().length).toBe(0);
      });
    });
  });

  await describe('deleting a message', async () => {
    const target = { remoteId: 'm1', fromSelf: true };
    const del = (world: World, backend: unknown, daemon: DaemonSendClient) =>
      deleteMessage({
        accountId: ACCOUNT,
        to: PEER,
        target,
        frontend: 'window',
        dbPath: world.dbPath,
        configPath: world.configPath,
        writeLogPath: world.writeLogPath,
        backend: backend as never,
        daemon,
      });

    await it('goes to the daemon first and opens no sender of its own', async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        const sender = new FakeSender('own');
        sender.features.deletes = true;
        const { backend, opened } = callerBackend(sender);
        const { client, asked } = fakeClient({
          v: DAEMON_WIRE_VERSION,
          kind: 'sent',
          markdown: false,
          steps: [],
        });
        await del(world, backend, client);
        expect(asked.length).toBe(1);
        expect(asked[0].delete).toStrictEqual({ target });
        expect(asked[0].text === undefined).toBe(true);
        expect(opened.length).toBe(0);
        expect(world.logLines().length).toBe(1);
        expect(world.logLines()[0]).toMatch(/delete:m1/);
      });
    });

    await it('falls back to its own sender when no daemon holds the account', async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        const sender = new FakeSender('own');
        sender.features.deletes = true;
        const { backend, opened } = callerBackend(sender);
        const { client } = fakeClient(null);
        await del(world, backend, client);
        expect(opened.length).toBe(1);
        expect(sender.deleted).toStrictEqual([{ to: PEER, target }]);
        expect(sender.closed).toBe(1);
        expect(world.logLines().length).toBe(1);
      });
    });

    await it('refuses a target that is not the persons own, and logs nothing', async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        const sender = new FakeSender('own');
        sender.features.deletes = true;
        const { backend, opened } = callerBackend(sender);
        const { client, asked } = fakeClient(null);
        await expect(
          deleteMessage({
            accountId: ACCOUNT,
            to: PEER,
            target: { remoteId: 'm1', fromSelf: false },
            frontend: 'window',
            dbPath: world.dbPath,
            configPath: world.configPath,
            writeLogPath: world.writeLogPath,
            backend: backend as never,
            daemon: client,
          }),
        ).rejects.toThrow(/only your own messages can be deleted/);
        // The daemon is asked first; only after it says it does not hold the account does the
        // direct path open a sender and refuse.
        expect(asked.length).toBe(1);
        expect(opened.length).toBe(1);
        expect(world.logLines().length).toBe(0);
      });
    });

    await it('refuses a sender that cannot delete, and logs nothing', async () => {
      await withWorld({ grants: GRANTS }, async (world) => {
        const sender = new FakeSender('own');
        const { backend, opened } = callerBackend(sender);
        const { client, asked } = fakeClient(null);
        await expect(del(world, backend, client)).rejects.toThrow(/cannot delete a message/);
        expect(asked.length).toBe(1);
        expect(opened.length).toBe(1);
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
    const handlerFor = (sessions: Map<string, DeliverySession>) => createDaemonSendHandler({ sessions, log });

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

    await it('hands the attachment paths to the sender and reports what it sent', async () => {
      const sender = new FakeSender('daemon');
      sender.features.attachments = true;
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(sender)]]);
      const reply = await handlerFor(sessions)(request({ attachments: ['/tmp/a.pdf', '/tmp/b.png'] }));
      expect(reply.kind).toBe('sent');
      expect(sender.sent[0].attachments?.map((a) => a.path).join()).toBe('/tmp/a.pdf,/tmp/b.png');
      if (reply.kind !== 'sent') return;
      expect(reply.steps[0].sent.attachments?.map((a) => a.filename).join()).toBe('a.pdf,b.png');
    });

    await it('refuses attachments for a sender that cannot carry them', async () => {
      const sender = new FakeSender('daemon');
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(sender)]]);
      const reply = await handlerFor(sessions)(request({ attachments: ['/tmp/a.pdf'] }));
      expect(reply.kind).toBe('failed');
      expect(sender.sent.length).toBe(0);
    });

    await it('hands the reply target to a sender that can reply, on the first text only', async () => {
      const sender = new FakeSender('daemon');
      sender.features.replies = true;
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(sender)]]);
      const replyTo = { remoteId: '$asked:example.org' };
      const reply = await handlerFor(sessions)(request({ replyTo }));
      expect(reply.kind).toBe('sent');
      expect(sender.sent[0].replyTo).toStrictEqual(replyTo);
      const plain = await handlerFor(sessions)(request());
      expect(plain.kind).toBe('sent');
      expect(sender.sent[1].replyTo === undefined).toBe(true);
    });

    await it('refuses a reply for a sender that cannot reply, and sends nothing', async () => {
      const sender = new FakeSender('daemon');
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(sender)]]);
      const reply = await handlerFor(sessions)(request({ replyTo: { remoteId: 'x' } }));
      expect(reply.kind).toBe('failed');
      if (reply.kind === 'failed') expect(reply.message).toMatch(/cannot send a reply/);
      expect(sender.sent.length).toBe(0);
    });

    await it('rejects a request whose replyTo has no remote id', async () => {
      for (const replyTo of [{}, { remoteId: '' }, { remoteId: 5 }, 'x']) {
        let message = '';
        try {
          parseDaemonSendRequest(JSON.stringify({ ...request(), replyTo }));
        } catch (err) {
          message = (err as Error).message;
        }
        expect(message).toMatch(/replyTo/);
      }
      expect(
        parseDaemonSendRequest(JSON.stringify({ ...request(), replyTo: { remoteId: 'm1' } })).replyTo
          ?.remoteId,
      ).toBe('m1');
    });

    await it('carries the sender-given id and the author flag of a reply, and rejects bad ones', async () => {
      const replyTo = { remoteId: 'm1', clientId: 'c1', fromSelf: true, text: 'Hi' };
      expect(parseDaemonSendRequest(JSON.stringify({ ...request(), replyTo })).replyTo).toStrictEqual(
        replyTo,
      );
      for (const bad of [
        { remoteId: 'm1', clientId: 5 },
        { remoteId: 'm1', fromSelf: 'yes' },
        { remoteId: 'm1', text: 5 },
      ]) {
        let message = '';
        try {
          parseDaemonSendRequest(JSON.stringify({ ...request(), replyTo: bad }));
        } catch (err) {
          message = (err as Error).message;
        }
        expect(message).toMatch(/replyTo/);
      }
    });

    await it('reacts through a sender that can react, and answers with no steps', async () => {
      const sender = new FakeSender('daemon');
      sender.features.reactions = true;
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(sender)]]);
      const target = { remoteId: 'm1', fromSelf: true };
      const reply = await handlerFor(sessions)(
        request({ text: undefined, reaction: { target, emoji: '👍' } }),
      );
      expect(reply.kind).toBe('sent');
      if (reply.kind === 'sent') expect(reply.steps.length).toBe(0);
      expect(sender.sent.length).toBe(0);
      expect(sender.reacted).toStrictEqual([{ to: PEER, target, emoji: '👍' }]);
      expect(sender.closed).toBe(1);
      const taken = await handlerFor(sessions)(
        request({ text: undefined, reaction: { target, emoji: null } }),
      );
      expect(taken.kind).toBe('sent');
      expect(sender.reacted[1].emoji).toBe(null);
    });

    await it('refuses a reaction for a sender that cannot react, and sends nothing', async () => {
      const sender = new FakeSender('daemon');
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(sender)]]);
      const reply = await handlerFor(sessions)(
        request({ text: undefined, reaction: { target: { remoteId: 'm1' }, emoji: '👍' } }),
      );
      expect(reply.kind).toBe('failed');
      if (reply.kind === 'failed') expect(reply.message).toMatch(/cannot send a reaction/);
      expect(sender.reacted.length).toBe(0);
    });

    await it('parses a reaction and rejects a malformed one or one mixed with a message', async () => {
      const bare = (over: object) => JSON.stringify({ ...request({ text: undefined }), ...over });
      const reaction = { target: { remoteId: 'm1', fromSelf: false }, emoji: '❤️' };
      expect(parseDaemonSendRequest(bare({ reaction })).reaction).toStrictEqual(reaction);
      expect(parseDaemonSendRequest(bare({ reaction: { ...reaction, emoji: null } })).reaction?.emoji).toBe(
        null,
      );
      expect(
        parseDaemonSendRequest(bare({ reaction: { ...reaction, emoji: null, previous: '👍' } })).reaction
          ?.previous,
      ).toBe('👍');
      const bad: object[] = [
        { reaction: 'x' },
        { reaction: { emoji: '👍' } },
        { reaction: { target: {}, emoji: '👍' } },
        { reaction: { target: { remoteId: 'm1' }, emoji: '' } },
        { reaction: { target: { remoteId: 'm1' }, emoji: 5 } },
        { reaction: { target: { remoteId: 'm1' } } },
        { reaction: { ...reaction, emoji: null, previous: '' } },
        { reaction: { ...reaction, emoji: null, previous: 5 } },
        { reaction, text: 'hi' },
        { reaction, attachments: [] },
        { reaction, replyTo: { remoteId: 'm2' } },
      ];
      for (const over of bad) {
        let message = '';
        try {
          parseDaemonSendRequest(bare(over));
        } catch (err) {
          message = (err as Error).message;
        }
        expect(message).toMatch(/reaction/);
      }
    });

    await it('edits through a sender that can edit, and answers with no steps', async () => {
      const sender = new FakeSender('daemon');
      sender.features.edits = true;
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(sender)]]);
      const target = { remoteId: 'm1', fromSelf: true };
      const reply = await handlerFor(sessions)(request({ text: undefined, edit: { target, text: 'fixed' } }));
      expect(reply.kind).toBe('sent');
      if (reply.kind === 'sent') expect(reply.steps.length).toBe(0);
      expect(sender.sent.length).toBe(0);
      expect(sender.edited).toStrictEqual([{ to: PEER, target, text: 'fixed' }]);
      expect(sender.closed).toBe(1);
    });

    await it('refuses an edit for a sender that cannot edit, and sends nothing', async () => {
      const sender = new FakeSender('daemon');
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(sender)]]);
      const reply = await handlerFor(sessions)(
        request({ text: undefined, edit: { target: { remoteId: 'm1' }, text: 'fixed' } }),
      );
      expect(reply.kind).toBe('failed');
      if (reply.kind === 'failed') expect(reply.message).toMatch(/cannot edit a message/);
      expect(sender.edited.length).toBe(0);
    });

    await it('refuses an edit of a message that is not the persons own', async () => {
      const sender = new FakeSender('daemon');
      sender.features.edits = true;
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(sender)]]);
      const reply = await handlerFor(sessions)(
        request({ text: undefined, edit: { target: { remoteId: 'm1', fromSelf: false }, text: 'fixed' } }),
      );
      expect(reply.kind).toBe('failed');
      if (reply.kind === 'failed') expect(reply.message).toMatch(/only your own messages can be edited/);
      expect(sender.edited.length).toBe(0);
    });

    await it('parses an edit and rejects a malformed one or one mixed with another send', async () => {
      const bare = (over: object) => JSON.stringify({ ...request({ text: undefined }), ...over });
      const edit = { target: { remoteId: 'm1', fromSelf: false }, text: 'fixed' };
      expect(parseDaemonSendRequest(bare({ edit })).edit).toStrictEqual(edit);
      const bad: object[] = [
        { edit: 'x' },
        { edit: { text: 'fixed' } },
        { edit: { target: {}, text: 'fixed' } },
        { edit: { target: { remoteId: 'm1' }, text: '' } },
        { edit: { target: { remoteId: 'm1' }, text: 5 } },
        { edit: { target: { remoteId: 'm1' } } },
        { edit, text: 'hi' },
        { edit, attachments: [] },
        { edit, replyTo: { remoteId: 'm2' } },
        { edit, reaction: { target: { remoteId: 'm2' }, emoji: '👍' } },
        { edit, delete: { target: { remoteId: 'm2' } } },
      ];
      for (const over of bad) {
        let message = '';
        try {
          parseDaemonSendRequest(bare(over));
        } catch (err) {
          message = (err as Error).message;
        }
        expect(message).toMatch(/edit/);
      }
    });

    await it('deletes through a sender that can delete, and answers with no steps', async () => {
      const sender = new FakeSender('daemon');
      sender.features.deletes = true;
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(sender)]]);
      const target = { remoteId: 'm1', fromSelf: true };
      const reply = await handlerFor(sessions)(request({ text: undefined, delete: { target } }));
      expect(reply.kind).toBe('sent');
      if (reply.kind === 'sent') expect(reply.steps.length).toBe(0);
      expect(sender.sent.length).toBe(0);
      expect(sender.deleted).toStrictEqual([{ to: PEER, target }]);
      expect(sender.closed).toBe(1);
    });

    await it('refuses a deletion for a sender that cannot delete, and sends nothing', async () => {
      const sender = new FakeSender('daemon');
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(sender)]]);
      const reply = await handlerFor(sessions)(
        request({ text: undefined, delete: { target: { remoteId: 'm1' } } }),
      );
      expect(reply.kind).toBe('failed');
      if (reply.kind === 'failed') expect(reply.message).toMatch(/cannot delete a message/);
      expect(sender.deleted.length).toBe(0);
    });

    await it('refuses a deletion of a message that is not the persons own', async () => {
      const sender = new FakeSender('daemon');
      sender.features.deletes = true;
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(sender)]]);
      const reply = await handlerFor(sessions)(
        request({ text: undefined, delete: { target: { remoteId: 'm1', fromSelf: false } } }),
      );
      expect(reply.kind).toBe('failed');
      if (reply.kind === 'failed') expect(reply.message).toMatch(/only your own messages can be deleted/);
      expect(sender.deleted.length).toBe(0);
    });

    await it('parses a deletion and rejects a malformed one or one mixed with another send', async () => {
      const bare = (over: object) => JSON.stringify({ ...request({ text: undefined }), ...over });
      const deletion = { target: { remoteId: 'm1', fromSelf: false } };
      expect(parseDaemonSendRequest(bare({ delete: deletion })).delete).toStrictEqual(deletion);
      const bad: object[] = [
        { delete: 'x' },
        { delete: {} },
        { delete: { target: {} } },
        { delete: deletion, text: 'hi' },
        { delete: deletion, attachments: [] },
        { delete: deletion, replyTo: { remoteId: 'm2' } },
        { delete: deletion, reaction: { target: { remoteId: 'm2' }, emoji: '👍' } },
        { delete: deletion, edit: { target: { remoteId: 'm2' }, text: 'fixed' } },
      ];
      for (const over of bad) {
        let message = '';
        try {
          parseDaemonSendRequest(bare(over));
        } catch (err) {
          message = (err as Error).message;
        }
        // Mixing a deletion with an edit is reported as an edit conflict because the edit check
        // runs first; every other bad case names the deletion.
        expect(message).toMatch(/edit|delet/);
      }
    });

    await it('rejects a request whose attachments are not a list of paths', async () => {
      const bad = JSON.stringify({ ...request(), attachments: [1] });
      let message = '';
      try {
        parseDaemonSendRequest(bad);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/attachments/);
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

    await it('checks no grant: the person sends from every account the daemon holds (ADR 0008)', async () => {
      const sender = new FakeSender('daemon');
      const session = heldSession(sender);
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), session]]);
      // No config, no grant anywhere — the handler has no way to read one.
      for (const to of [PEER, 'other@example.org']) {
        const reply = await handlerFor(sessions)(request({ to }));
        expect(reply.kind).toBe('sent');
      }
      expect(sender.sent.length).toBe(2);
      // The permit names the one address asked for, so the sender's own check still has teeth.
      expect(session.permits.map((p) => p.addresses.join()).join('|')).toBe(`${PEER}|other@example.org`);
    });

    await it('refuses a capability that is not the one this backend sends under', async () => {
      const sender = new FakeSender('daemon');
      const sessions = new Map([[sessionKey(BACKEND, ACCOUNT), heldSession(sender)]]);
      // Another backend's capability on the same pair must not open this one's session — the
      // pair is checked together with the backend, never alone. Not a grant check: a request that
      // contradicts itself is a mistake in the caller.
      const reply = await handlerFor(sessions)(request({ capability: 'xmpp.send' }));
      expect(reply.kind).toBe('refused');
      expect(sender.sent.length).toBe(0);
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
