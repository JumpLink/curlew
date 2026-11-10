import { describe, expect, it } from '@gjsify/unit';

import {
  chatConversationId,
  readChanges,
  receiveDeliveries,
  rebuildConversations,
  recordSentChatMessage,
  syncIndex,
  syncChats,
  type IndexDatabase,
} from '@curlew/store';
import type {
  BackendAccount,
  ChatMessage,
  ChatPeer,
  DeliveryBackend,
  DeliveryEvent,
  DeliveryOutcome,
  DeliverySession,
} from '@curlew/protocol';
import { PLUGIN_API_VERSION } from '@curlew/protocol';
import { chatMessage, FakeChatBackend, BEN, telegramFixture } from './chat-fixtures.ts';
import { AT, FakeBackend, freshDb, message } from './fixtures.ts';

/**
 * Every write path appends to the change journal (ADR 0007 §2), and a write that changes
 * nothing appends nothing. A row is `kind|backend|account|conversation`; synthetic ids only.
 */

const ACCOUNT = 'telegram-42';
const DIRECT = chatConversationId('telegram', ACCOUNT, '1001');
const GROUP = chatConversationId('telegram', ACCOUNT, '-4001');
const CHANNEL = chatConversationId('telegram', ACCOUNT, '-1005000');
const BEN_CHAT = chatConversationId('telegram', ACCOUNT, '1002');

/** The journal after `since`, as sorted strings. */
function rowsAfter(db: IndexDatabase, since = 0): string[] {
  return readChanges(db, since, 1000)
    .changes.map((c) => [c.kind, c.backend, c.accountId, c.conversationId].join('|'))
    .sort();
}

function newest(db: IndexDatabase): number {
  return readChanges(db, 0, 1).newest ?? 0;
}

const row = (conversationId: string) => `messages|telegram|${ACCOUNT}|${conversationId}`;

const D_BACKEND = 'fakedelivery';
const D_ACCOUNT = 'fake-1';
const dconv = (chat: string) => chatConversationId(D_BACKEND, D_ACCOUNT, chat);
const drow = (chat: string) => `messages|${D_BACKEND}|${D_ACCOUNT}|${dconv(chat)}`;

const ANNA: ChatPeer = {
  remoteId: 'anna',
  displayName: 'Anna Example',
  addresses: [{ kind: 'phone', value: '+491510000001' }],
  bot: false,
};

function dmsg(id: string, seq: number, body: string): ChatMessage {
  return {
    remoteId: id,
    seq,
    sentAt: new Date(Date.UTC(2026, 0, 1, 12, 0, seq)).toISOString(),
    editedAt: null,
    sender: ANNA,
    fromSelf: false,
    text: body,
    hasAttachments: false,
    replyToRemoteId: null,
    threadRemoteId: null,
  };
}

const incoming = (chat: string, m: ChatMessage): DeliveryEvent => ({
  type: 'message',
  chatRemoteId: chat,
  chatKind: 'direct',
  message: m,
  seen: false,
});

function fakeDelivery(batches: DeliveryEvent[][], outcome: DeliveryOutcome): DeliveryBackend {
  return {
    manifest: {
      name: D_BACKEND,
      displayName: 'Fake delivery',
      pluginApi: PLUGIN_API_VERSION,
      capabilities: {
        edits: true,
        reactions: false,
        threads: false,
        readReceipts: true,
        groups: true,
        e2ee: true,
        subject: false,
        folders: false,
        attachments: true,
        attachmentsRead: false,
        replies: false,
      },
      syncModel: 'delivery-only',
      native: false,
      addressKinds: ['phone'],
      terms: null,
    },
    kind: 'delivery',
    async listAccounts(): Promise<BackendAccount[]> {
      return [{ id: D_ACCOUNT, identity: 'Me', provider: 'Fake' }];
    },
    async connect(): Promise<DeliverySession> {
      const queue = [...batches];
      return {
        nextBatch: async () => queue.shift() ?? null,
        outcome: () => outcome,
        close: async () => undefined,
      };
    },
  };
}

const CAUGHT_UP: DeliveryOutcome = { caughtUp: true, error: null };

export default async () => {
  await describe('the change journal: chat writes', async () => {
    await it('a first sync appends one row per chat that has news', async () => {
      const db = freshDb();
      try {
        await syncChats(db, telegramFixture(), { now: AT('2026-08-06T12:00:00Z') });
        expect(rowsAfter(db).join(' ')).toBe([row(DIRECT), row(GROUP), row(CHANNEL)].sort().join(' '));
      } finally {
        db.close();
      }
    });

    await it('a sync that finds nothing new appends nothing', async () => {
      const db = freshDb();
      try {
        const backend = telegramFixture();
        await syncChats(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        const seen = newest(db);
        await syncChats(db, backend, { now: AT('2026-08-06T13:00:00Z') });
        expect(newest(db)).toBe(seen);
      } finally {
        db.close();
      }
    });

    await it('a new message touches only its own chat', async () => {
      const db = freshDb();
      try {
        const backend = telegramFixture();
        await syncChats(db, backend);
        const seen = newest(db);
        backend.post('1001', chatMessage('1001', 4, 'me', 'noch eins'));
        await syncChats(db, backend);
        expect(rowsAfter(db, seen).join(' ')).toBe(row(DIRECT));
      } finally {
        db.close();
      }
    });

    await it('a moved read marker touches its chat', async () => {
      const db = freshDb();
      try {
        const backend = telegramFixture();
        await syncChats(db, backend);
        const seen = newest(db);
        backend.markRead('1001', 3);
        await syncChats(db, backend);
        expect(rowsAfter(db, seen).join(' ')).toBe(row(DIRECT));
      } finally {
        db.close();
      }
    });

    await it('a deleted message and a vanished chat are both journalled', async () => {
      const db = freshDb();
      try {
        const backend = new FakeChatBackend();
        backend.addChat({ remoteId: '1002', kind: 'direct', title: 'Ben', members: [BEN] });
        backend.addChat({ remoteId: '1003', kind: 'direct', title: 'Ben 2', members: [BEN] });
        for (let seq = 1; seq <= 5; seq++) backend.post('1002', chatMessage('1002', seq, BEN, `m${seq}`));
        backend.post('1003', chatMessage('1003', 1, BEN, 'x'));
        await syncChats(db, backend, { historyDepth: 10 });
        const seen = newest(db);
        const chat = backend.chats.get('1002');
        if (!chat) throw new Error('fixture chat missing');
        chat.messages = chat.messages.filter((m) => m.seq !== 5);
        backend.chats.delete('1003');
        await syncChats(db, backend, { historyDepth: 10, fullScan: true });
        expect(rowsAfter(db, seen).join(' ')).toBe(
          [row(BEN_CHAT), row(chatConversationId('telegram', ACCOUNT, '1003'))].sort().join(' '),
        );
      } finally {
        db.close();
      }
    });

    await it('recordSentChatMessage journals the chat it wrote into', async () => {
      const db = freshDb();
      try {
        recordSentChatMessage(db, {
          backend: 'telegram',
          account: { id: ACCOUNT, identity: '@me_example', provider: 'Telegram' },
          chatRemoteId: '1002',
          clientId: 'oid-1',
          text: 'nur lokal bekannt',
          sentAt: '2026-08-01T10:00:00.000Z',
        });
        expect(rowsAfter(db).join(' ')).toBe(row(BEN_CHAT));
      } finally {
        db.close();
      }
    });
  });

  await describe('the change journal: delivery writes', async () => {
    await it('a batch of messages journals each chat once, a peer-only batch nothing', async () => {
      const db = freshDb();
      try {
        await receiveDeliveries(
          db,
          fakeDelivery(
            [
              [
                incoming('d-anna', dmsg('d-anna/1', 1, 'Hallo')),
                incoming('d-anna', dmsg('d-anna/2', 2, 'Noch eins')),
                incoming('d-ben', dmsg('d-ben/1', 3, 'Hi')),
              ],
              [{ type: 'peer', peer: ANNA }],
            ],
            CAUGHT_UP,
          ),
        );
        expect(rowsAfter(db).join(' ')).toBe([drow('d-anna'), drow('d-ben')].sort().join(' '));
        const seen = newest(db);
        await receiveDeliveries(db, fakeDelivery([[{ type: 'peer', peer: ANNA }]], CAUGHT_UP));
        expect(newest(db)).toBe(seen);
      } finally {
        db.close();
      }
    });

    await it('an edit, a deletion, a cleared and a deleted chat are journalled', async () => {
      const db = freshDb();
      try {
        await receiveDeliveries(
          db,
          fakeDelivery(
            [
              [
                incoming('d-a', dmsg('d-a/1', 1, 'eins')),
                incoming('d-b', dmsg('d-b/1', 2, 'zwei')),
                incoming('d-c', dmsg('d-c/1', 3, 'drei')),
                incoming('d-e', dmsg('d-e/1', 4, 'vier')),
              ],
            ],
            CAUGHT_UP,
          ),
        );
        const seen = newest(db);
        await receiveDeliveries(
          db,
          fakeDelivery(
            [
              [
                {
                  type: 'edit',
                  chatRemoteId: 'd-a',
                  remoteId: 'd-a/1',
                  text: 'neu',
                  editedAt: '2026-01-02T00:00:00.000Z',
                },
                { type: 'delete', chatRemoteId: 'd-b', remoteId: 'd-b/1' },
                { type: 'chat-cleared', chatRemoteId: 'd-c' },
                { type: 'chat-deleted', chatRemoteId: 'd-e' },
              ],
            ],
            CAUGHT_UP,
          ),
        );
        expect(rowsAfter(db, seen).join(' ')).toBe(
          [drow('d-a'), drow('d-b'), drow('d-c'), drow('d-e')].sort().join(' '),
        );
      } finally {
        db.close();
      }
    });

    await it('a merge journals both sides of it', async () => {
      const db = freshDb();
      try {
        await receiveDeliveries(
          db,
          fakeDelivery([[incoming('pn-anna', dmsg('pn-anna/1', 1, 'alt'))]], CAUGHT_UP),
        );
        const seen = newest(db);
        await receiveDeliveries(
          db,
          fakeDelivery(
            [
              [
                { type: 'chat-merged', from: 'pn-anna', into: 'lid-anna' },
                incoming('lid-anna', dmsg('lid-anna/2', 2, 'neu')),
              ],
            ],
            CAUGHT_UP,
          ),
        );
        expect(rowsAfter(db, seen).join(' ')).toBe([drow('pn-anna'), drow('lid-anna')].sort().join(' '));
      } finally {
        db.close();
      }
    });

    await it('journals the account only when the link state flips', async () => {
      const db = freshDb();
      try {
        const dropped: DeliveryOutcome = { caughtUp: true, error: null, loggedOut: true };
        await receiveDeliveries(db, fakeDelivery([], CAUGHT_UP));
        expect(newest(db)).toBe(0);
        await receiveDeliveries(db, fakeDelivery([], dropped));
        expect(rowsAfter(db).join(' ')).toBe(`accounts|${D_BACKEND}|${D_ACCOUNT}|null`.replace('null', ''));
        const seen = newest(db);
        await receiveDeliveries(db, fakeDelivery([], dropped));
        expect(newest(db)).toBe(seen);
        await receiveDeliveries(db, fakeDelivery([], CAUGHT_UP));
        expect(newest(db) > seen).toBe(true);
      } finally {
        db.close();
      }
    });
  });

  await describe('the change journal: mail and the conversation rebuild', async () => {
    await it('a mailbox pass journals the account once, and only when something changed', async () => {
      const db = freshDb();
      try {
        const backend = new FakeBackend();
        backend.put('INBOX', [message(1, 'Energieberatung'), message(2, 'Angebot')]);
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        expect(rowsAfter(db).join(' ')).toBe(`messages|${backend.manifest.name}|acct|`);
        const seen = newest(db);
        await syncIndex(db, backend, { now: AT('2026-08-06T13:00:00Z') });
        expect(newest(db)).toBe(seen);
        backend.put('INBOX', [message(1, 'Energieberatung'), message(2, 'Angebot'), message(3, 'Neu')]);
        await syncIndex(db, backend, { now: AT('2026-08-06T14:00:00Z') });
        expect(rowsAfter(db, seen).length).toBe(1);
      } finally {
        db.close();
      }
    });

    await it('a rebuild that changed something journals once, a steady-state one nothing', async () => {
      const db = freshDb();
      try {
        const backend = new FakeBackend();
        backend.put('INBOX', [message(1, 'Energieberatung')]);
        await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
        const afterSync = newest(db);
        rebuildConversations(db);
        expect(rowsAfter(db, afterSync).join(' ')).toBe('conversations|||');
        const seen = newest(db);
        rebuildConversations(db);
        expect(newest(db)).toBe(seen);
      } finally {
        db.close();
      }
    });
  });
};
