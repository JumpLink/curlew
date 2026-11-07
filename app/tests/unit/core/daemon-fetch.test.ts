import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AttachmentFetcher,
  type BackendAccount,
  type BackendCapabilities,
  type ByteSink,
  type ChatBackend,
  type ChatHistoryPage,
  type ChatInfo,
  type ChatSession,
  type DeliveryBackend,
  type DeliverySession,
  type MessageBackend,
  PLUGIN_API_VERSION,
} from '@curlew/protocol';
import { freshDb } from '../store/fixtures.ts';
import { createDaemonFetchHandler, sessionKey } from '../../../src/core/actions/daemon.ts';
import {
  DAEMON_WIRE_VERSION,
  parseDaemonFetchAttachmentRequest,
  type DaemonFetchAttachmentRequest,
} from '../../../src/core/lib/daemon-bus.ts';

const CHAT_BACKEND = 'matrix';
const DELIVERY_BACKEND = 'signal';
const ACCOUNT = 'matrix-abc';
const REMOTE_ID = '$remote-1:example.org';
const HANDLE = JSON.stringify({ fileId: 'file-1' });

const ACCOUNT_INFO: BackendAccount = { id: ACCOUNT, identity: ACCOUNT, provider: 'matrix' };
const CAPABILITIES: BackendCapabilities = {
  edits: false,
  reactions: false,
  threads: false,
  readReceipts: false,
  groups: false,
  e2ee: true,
  subject: false,
  folders: false,
  attachments: false,
  attachmentsRead: true,
};

function fakeSession(): ChatSession {
  return {
    listChats: async (): Promise<ChatInfo[]> => [],
    fetchHistory: async (): Promise<ChatHistoryPage> => ({
      messages: [],
      highestSeq: null,
      lowestSeq: null,
      exhausted: true,
      reachedStart: true,
    }),
    close: async () => {},
  };
}

function fakeFetcher(bytes: Uint8Array, mimeType: string | null): AttachmentFetcher {
  return {
    fetchAttachment: async (
      _account: { backend: string; accountId: string },
      _attachment: { kind: string; handle: string },
      sink: ByteSink,
    ): Promise<{ mimeType: string | null; size: number }> => {
      await sink.write(bytes);
      sink.close();
      return { mimeType, size: bytes.length };
    },
  };
}

function fakeChatBackend(fetcher?: AttachmentFetcher): ChatBackend & {
  openAttachments: NonNullable<MessageBackend['openAttachments']>;
} {
  return {
    manifest: {
      name: CHAT_BACKEND,
      displayName: 'Fake chat backend',
      pluginApi: PLUGIN_API_VERSION,
      capabilities: CAPABILITIES,
      syncModel: 'server-archive',
      native: false,
      addressKinds: ['matrix'],
      terms: null,
    },
    kind: 'chat',
    listAccounts: async () => [ACCOUNT_INFO],
    connect: async () => fakeSession(),
    openAttachments: async () => fetcher ?? fakeFetcher(new Uint8Array(0), null),
  };
}

function fakeDeliveryBackend(fetcher?: AttachmentFetcher): DeliveryBackend & {
  openAttachments: NonNullable<MessageBackend['openAttachments']>;
} {
  return {
    manifest: {
      name: DELIVERY_BACKEND,
      displayName: 'Fake delivery backend',
      pluginApi: PLUGIN_API_VERSION,
      capabilities: CAPABILITIES,
      syncModel: 'delivery-only',
      native: false,
      addressKinds: ['signal'],
      terms: null,
    },
    kind: 'delivery',
    listAccounts: async () => [{ id: ACCOUNT, identity: ACCOUNT, provider: 'signal' }],
    connect: async () =>
      ({
        nextBatch: async () => null,
        outcome: () => ({ caughtUp: true, error: null }),
        close: async () => {},
      }) satisfies DeliverySession,
    openAttachments: async () => fetcher ?? fakeFetcher(new Uint8Array(0), null),
  };
}

function seedMessage(db: ReturnType<typeof freshDb>, backend: string, handle: string | null): void {
  const conversationId = `${backend}:${ACCOUNT}:!room:example.org`;
  db.prepare(
    `INSERT INTO conversations (id, backend, account_id, kind, classification, classification_reason)
     VALUES (?, ?, ?, 'direct', 'chat', 'synthetic')`,
  ).run(conversationId, backend, ACCOUNT);
  db.prepare(
    `INSERT INTO conversation_messages
       (id, conversation_id, backend, account_id, presentation, remote_id, has_attachments,
        classification, classification_reason, from_self)
     VALUES (?, ?, ?, ?, 'bubble', ?, 1, 'chat', 'synthetic', 0)`,
  ).run(`${REMOTE_ID}-msg`, conversationId, backend, ACCOUNT, REMOTE_ID);
  db.prepare(
    `INSERT INTO message_attachments (message_id, idx, filename, mime_type, size, kind, handle)
       VALUES (?, 0, 'photo.jpg', 'image/jpeg', 42, 'image', ?)`,
  ).run(`${REMOTE_ID}-msg`, handle);
}

function fetchRequest(over: Partial<DaemonFetchAttachmentRequest> = {}): DaemonFetchAttachmentRequest {
  return {
    v: DAEMON_WIRE_VERSION,
    backend: CHAT_BACKEND,
    account: ACCOUNT,
    remoteId: REMOTE_ID,
    index: 0,
    maxBytes: 1_000_000,
    ...over,
  };
}

export default async () => {
  await describe('the attachment fetch request on the wire', async () => {
    await it('accepts the first attachment, index 0', async () => {
      const request = fetchRequest({ index: 0 });
      expect(parseDaemonFetchAttachmentRequest(JSON.stringify(request)).index).toBe(0);
    });

    await it('rejects a wrong version, a negative index and a zero byte cap', async () => {
      for (const bad of [{ v: DAEMON_WIRE_VERSION + 1 }, { index: -1 }, { maxBytes: 0 }, { remoteId: '' }]) {
        let threw = false;
        try {
          parseDaemonFetchAttachmentRequest(JSON.stringify(fetchRequest(bad)));
        } catch {
          threw = true;
        }
        expect(threw).toBe(true);
      }
    });
  });

  await describe('the daemon answering an attachment fetch', async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    await it('fetches the attachment and returns the daemon preview path', async () => {
      const db = freshDb();
      const dir = mkdtempSync(join(tmpdir(), 'curlew-daemon-fetch-'));
      const previous = process.env.CURLEW_PREVIEWS_DIR;
      try {
        process.env.CURLEW_PREVIEWS_DIR = dir;
        const data = new TextEncoder().encode('synthetic image bytes');
        const backend = fakeChatBackend(fakeFetcher(data, 'image/jpeg'));
        const fetchBackends = new Map([[sessionKey(CHAT_BACKEND, ACCOUNT), backend]]);
        seedMessage(db, CHAT_BACKEND, HANDLE);
        const handler = createDaemonFetchHandler({ db, fetchBackends, log });
        const reply = await handler(fetchRequest());
        expect(reply.kind).toBe('fetched');
        if (reply.kind !== 'fetched') return;
        expect(reply.filename).toBe('photo.jpg');
        expect(reply.bytes).toBe(data.length);
        expect(reply.mimeType).toBe('image/jpeg');
        expect(new Uint8Array(readFileSync(reply.path))).toStrictEqual(data);
        expect(lines.some((l) => l.includes('fetched attachment'))).toBe(true);
      } finally {
        process.env.CURLEW_PREVIEWS_DIR = previous;
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('fetches from a delivery-kind backend the daemon holds', async () => {
      const db = freshDb();
      const dir = mkdtempSync(join(tmpdir(), 'curlew-daemon-fetch-'));
      const previous = process.env.CURLEW_PREVIEWS_DIR;
      try {
        process.env.CURLEW_PREVIEWS_DIR = dir;
        const data = new TextEncoder().encode('synthetic delivery bytes');
        const backend = fakeDeliveryBackend(fakeFetcher(data, 'image/jpeg'));
        const fetchBackends = new Map([[sessionKey(DELIVERY_BACKEND, ACCOUNT), backend]]);
        seedMessage(db, DELIVERY_BACKEND, HANDLE);
        const handler = createDaemonFetchHandler({ db, fetchBackends, log });
        const reply = await handler(fetchRequest({ backend: DELIVERY_BACKEND }));
        expect(reply.kind).toBe('fetched');
        if (reply.kind !== 'fetched') return;
        expect(reply.bytes).toBe(data.length);
      } finally {
        process.env.CURLEW_PREVIEWS_DIR = previous;
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('is not-followed for an account it does not hold', async () => {
      const db = freshDb();
      try {
        seedMessage(db, CHAT_BACKEND, HANDLE);
        const handler = createDaemonFetchHandler({
          db,
          fetchBackends: new Map(),
          log,
        });
        const reply = await handler(fetchRequest());
        expect(reply.kind).toBe('not-followed');
      } finally {
        db.close();
      }
    });

    await it('fails when the message has no attachment handle', async () => {
      const db = freshDb();
      try {
        seedMessage(db, CHAT_BACKEND, null);
        const backend = fakeChatBackend();
        const fetchBackends = new Map([[sessionKey(CHAT_BACKEND, ACCOUNT), backend]]);
        const handler = createDaemonFetchHandler({ db, fetchBackends, log });
        const reply = await handler(fetchRequest());
        expect(reply.kind).toBe('failed');
        expect(reply.kind === 'failed' && /not found/.test(reply.message)).toBe(true);
      } finally {
        db.close();
      }
    });

    await it('fails when the fetch itself errors', async () => {
      const db = freshDb();
      try {
        seedMessage(db, CHAT_BACKEND, HANDLE);
        const backend = fakeChatBackend({
          fetchAttachment: async () => {
            throw new Error('network down');
          },
        });
        const fetchBackends = new Map([[sessionKey(CHAT_BACKEND, ACCOUNT), backend]]);
        const handler = createDaemonFetchHandler({ db, fetchBackends, log });
        const reply = await handler(fetchRequest());
        expect(reply.kind).toBe('failed');
        expect(reply.kind === 'failed' && /network down/.test(reply.message)).toBe(true);
      } finally {
        db.close();
      }
    });
  });
};
