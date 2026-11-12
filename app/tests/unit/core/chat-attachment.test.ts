import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  PLUGIN_API_VERSION,
} from '@curlew/protocol';
import type { freshDb } from '../store/fixtures.ts';
import { chatSaveAttachment } from '../../../src/core/actions/chat-attachment.ts';
import { openIndex } from '../../../src/core/actions/index-sync.ts';
import { DAEMON_WIRE_VERSION, type DaemonFetchAttachmentReply } from '../../../src/core/lib/daemon-bus.ts';
import type { DaemonSendClient } from '../../../src/core/lib/daemon-send-client.ts';

const BACKEND = 'telegram';
const ACCOUNT = 'telegram-abc';
const REMOTE_ID = 'msg-1';
const HANDLE = JSON.stringify({ fileId: 'file-1' });

const ACCOUNT_INFO: BackendAccount = { id: ACCOUNT, identity: ACCOUNT, provider: 'telegram' };
const CAPABILITIES: BackendCapabilities = {
  edits: false,
  reactions: false,
  threads: false,
  readReceipts: false,
  groups: true,
  e2ee: false,
  subject: false,
  folders: false,
  attachments: true,
  attachmentsRead: true,
  replies: false,
  editsOwn: false,
  deletesOwn: false,
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

function fakeBackend(fetcher?: AttachmentFetcher): ChatBackend & {
  openAttachments: NonNullable<ChatBackend['openAttachments']>;
} {
  return {
    manifest: {
      name: BACKEND,
      displayName: 'Fake chat backend',
      pluginApi: PLUGIN_API_VERSION,
      capabilities: CAPABILITIES,
      syncModel: 'server-archive',
      native: false,
      addressKinds: ['telegram'],
      terms: null,
    },
    kind: 'chat',
    listAccounts: async () => [ACCOUNT_INFO],
    connect: async () => fakeSession(),
    openAttachments: async () => fetcher ?? fakeFetcher(new Uint8Array(0), null),
  };
}

function seedMessage(db: ReturnType<typeof freshDb>, handle: string | null): void {
  const conversationId = `${BACKEND}:${ACCOUNT}:peer-1`;
  db.prepare(
    `INSERT INTO conversations (id, backend, account_id, kind, classification, classification_reason)
     VALUES (?, ?, ?, 'direct', 'chat', 'synthetic')`,
  ).run(conversationId, BACKEND, ACCOUNT);
  db.prepare(
    `INSERT INTO conversation_messages
       (id, conversation_id, backend, account_id, presentation, remote_id, has_attachments,
        classification, classification_reason, from_self)
     VALUES (?, ?, ?, ?, 'bubble', ?, 1, 'chat', 'synthetic', 0)`,
  ).run(`${REMOTE_ID}-msg`, conversationId, BACKEND, ACCOUNT, REMOTE_ID);
  db.prepare(
    `INSERT INTO message_attachments (message_id, idx, filename, mime_type, size, kind, handle)
       VALUES (?, 0, 'doc.pdf', 'application/pdf', 99, 'file', ?)`,
  ).run(`${REMOTE_ID}-msg`, handle);
}

function fakeDaemon(reply: DaemonFetchAttachmentReply | null): DaemonSendClient {
  return {
    send: async () => null,
    fetchAttachment: async () => reply,
    fetchAvatars: async () => null,
  };
}

interface World {
  dir: string;
  dbPath: string;
  configPath: string;
  attachmentsDir: string;
}

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-chat-attachment-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({}));
  const attachmentsDir = join(dir, 'attachments');
  const previousAttachments = process.env.CURLEW_ATTACHMENTS_DIR;
  try {
    process.env.CURLEW_ATTACHMENTS_DIR = attachmentsDir;
    await body({
      dir,
      dbPath: join(dir, 'index.db'),
      configPath,
      attachmentsDir,
    });
  } finally {
    process.env.CURLEW_ATTACHMENTS_DIR = previousAttachments;
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async () => {
  await describe('chatSaveAttachment', async () => {
    await it('fetches through the daemon when it holds the account', async () => {
      await withWorld(async (world) => {
        const db = openIndex(world.dbPath);
        try {
          seedMessage(db, HANDLE);
        } finally {
          db.close();
        }
        const daemonPath = join(world.attachmentsDir, 'daemon-preview', 'doc.pdf');
        const saved = await chatSaveAttachment({
          ref: { backend: BACKEND, accountId: ACCOUNT, remoteId: REMOTE_ID },
          index: 0,
          configPath: world.configPath,
          dbPath: world.dbPath,
          daemon: fakeDaemon({
            v: DAEMON_WIRE_VERSION,
            kind: 'fetched',
            path: daemonPath,
            filename: 'doc.pdf',
            bytes: 1234,
            mimeType: 'application/pdf',
          }),
        });
        expect(saved.path).toBe(daemonPath);
        expect(saved.filename).toBe('doc.pdf');
        expect(saved.bytes).toBe(1234);
        expect(saved.mimeType).toBe('application/pdf');
      });
    });

    await it('falls back to the direct backend path when the daemon does not hold the account', async () => {
      await withWorld(async (world) => {
        const db = openIndex(world.dbPath);
        const data = new TextEncoder().encode('pdf body');
        try {
          seedMessage(db, HANDLE);
        } finally {
          db.close();
        }
        const saved = await chatSaveAttachment({
          ref: { backend: BACKEND, accountId: ACCOUNT, remoteId: REMOTE_ID },
          index: 0,
          configPath: world.configPath,
          dbPath: world.dbPath,
          backend: fakeBackend(fakeFetcher(data, 'application/pdf')),
          daemon: fakeDaemon(null),
        });
        expect(saved.mimeType).toBe('application/pdf');
        expect(saved.bytes).toBe(data.length);
        expect(new Uint8Array(readFileSync(saved.path))).toStrictEqual(data);
      });
    });

    await it('takes the direct path when the daemon answers not-followed', async () => {
      await withWorld(async (world) => {
        const db = openIndex(world.dbPath);
        const data = new TextEncoder().encode('direct bytes');
        try {
          seedMessage(db, HANDLE);
        } finally {
          db.close();
        }
        const saved = await chatSaveAttachment({
          ref: { backend: BACKEND, accountId: ACCOUNT, remoteId: REMOTE_ID },
          index: 0,
          configPath: world.configPath,
          dbPath: world.dbPath,
          backend: fakeBackend(fakeFetcher(data, 'application/pdf')),
          daemon: fakeDaemon({ v: DAEMON_WIRE_VERSION, kind: 'not-followed' }),
        });
        expect(saved.bytes).toBe(data.length);
        expect(new Uint8Array(readFileSync(saved.path))).toStrictEqual(data);
      });
    });

    await it('throws when the daemon refuses or fails', async () => {
      await withWorld(async (world) => {
        const db = openIndex(world.dbPath);
        try {
          seedMessage(db, HANDLE);
        } finally {
          db.close();
        }
        await expect(
          chatSaveAttachment({
            ref: { backend: BACKEND, accountId: ACCOUNT, remoteId: REMOTE_ID },
            index: 0,
            configPath: world.configPath,
            dbPath: world.dbPath,
            daemon: fakeDaemon({ v: DAEMON_WIRE_VERSION, kind: 'failed', message: 'daemon busy' }),
          }),
        ).rejects.toThrow(/daemon busy/);
      });
    });

    await it('refuses an agent without read access before any bytes move', async () => {
      await withWorld(async (world) => {
        const db = openIndex(world.dbPath);
        try {
          seedMessage(db, HANDLE);
        } finally {
          db.close();
        }
        let fetched = false;
        const backend = fakeBackend({
          fetchAttachment: async () => {
            fetched = true;
            return { mimeType: null, size: 0 };
          },
        });
        await expect(
          chatSaveAttachment({
            ref: { backend: BACKEND, accountId: ACCOUNT, remoteId: REMOTE_ID },
            index: 0,
            configPath: world.configPath,
            dbPath: world.dbPath,
            backend,
            daemon: fakeDaemon(null),
            agent: { frontend: 'mcp' },
          }),
        ).rejects.toThrow();
        expect(fetched).toBe(false);
      });
    });

    await it('throws when the attachment is not in the index', async () => {
      await withWorld(async (world) => {
        const db = openIndex(world.dbPath);
        try {
          seedMessage(db, HANDLE);
        } finally {
          db.close();
        }
        await expect(
          chatSaveAttachment({
            ref: { backend: BACKEND, accountId: ACCOUNT, remoteId: REMOTE_ID },
            index: 99,
            configPath: world.configPath,
            dbPath: world.dbPath,
          }),
        ).rejects.toThrow(/not found in the index/);
      });
    });

    await it('throws when the stored attachment has no handle', async () => {
      await withWorld(async (world) => {
        const db = openIndex(world.dbPath);
        try {
          seedMessage(db, null);
        } finally {
          db.close();
        }
        await expect(
          chatSaveAttachment({
            ref: { backend: BACKEND, accountId: ACCOUNT, remoteId: REMOTE_ID },
            index: 0,
            configPath: world.configPath,
            dbPath: world.dbPath,
          }),
        ).rejects.toThrow(/no fetchable handle/);
      });
    });

    await it('throws when the backend cannot fetch attachments', async () => {
      await withWorld(async (world) => {
        const db = openIndex(world.dbPath);
        try {
          seedMessage(db, HANDLE);
        } finally {
          db.close();
        }
        const noFetch = fakeBackend();
        delete (noFetch as { openAttachments?: unknown }).openAttachments;
        await expect(
          chatSaveAttachment({
            ref: { backend: BACKEND, accountId: ACCOUNT, remoteId: REMOTE_ID },
            index: 0,
            configPath: world.configPath,
            dbPath: world.dbPath,
            backend: noFetch as ChatBackend,
            daemon: fakeDaemon(null),
          }),
        ).rejects.toThrow(/cannot fetch attachments/);
      });
    });
  });
};
