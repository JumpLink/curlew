import { describe, expect, it } from '@gjsify/unit';

import type {
  BackendAccount,
  ChatMessage,
  ChatPeer,
  DeliveryBackend,
  DeliveryEvent,
  DeliveryOutcome,
  DeliverySession,
} from '@curlew/protocol';
import { isDeliveryBackend, PLUGIN_API_VERSION } from '@curlew/protocol';
import {
  chatConversationId,
  deliveredMessageId,
  getConversation,
  listConversations,
  rebuildConversations,
  receiveDeliveries,
  recordSentChatMessage,
} from '@curlew/store';
import { freshDb } from './fixtures.ts';

/**
 * The delivery engine without a network: a scripted `DeliveryBackend` hands out batches of
 * events, and the index must end up holding exactly what they describe — messages, edits,
 * deletions, read state — through the same chat tables every read path already knows. All data
 * is synthetic.
 */

const BACKEND = 'fakedelivery';
const ACCOUNT = 'fake-1';

function fakeBackend(
  batches: DeliveryEvent[][],
  outcome: DeliveryOutcome = { caughtUp: true, error: null },
  log: { connects: number; closed: number } = { connects: 0, closed: 0 },
): DeliveryBackend {
  return {
    manifest: {
      name: BACKEND,
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
      },
      syncModel: 'delivery-only',
      native: false,
      addressKinds: ['phone'],
      terms: null,
    },
    kind: 'delivery',
    async listAccounts(): Promise<BackendAccount[]> {
      return [{ id: ACCOUNT, identity: 'Me', provider: 'Fake' }];
    },
    async connect(): Promise<DeliverySession> {
      log.connects++;
      const queue = [...batches];
      return {
        nextBatch: async () => queue.shift() ?? null,
        outcome: () => outcome,
        close: async () => {
          log.closed++;
        },
      };
    },
  };
}

const ANNA: ChatPeer = {
  remoteId: 'anna',
  displayName: 'Anna Example',
  addresses: [{ kind: 'phone', value: '+491510000001' }],
  bot: false,
};

function msg(id: string, seq: number, body: string | null, extra: Partial<ChatMessage> = {}): ChatMessage {
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
    ...extra,
  };
}

const incoming = (chat: string, m: ChatMessage, seen = false): DeliveryEvent => ({
  type: 'message',
  chatRemoteId: chat,
  chatKind: chat.startsWith('g') ? 'group' : 'direct',
  message: m,
  seen,
});

const conv = (chat: string) => chatConversationId(BACKEND, ACCOUNT, chat);

export default async () => {
  await describe('receiveDeliveries', async () => {
    await it('is the delivery driver and writes chats, peers and messages as chat rows', async () => {
      const db = freshDb();
      try {
        const backend = fakeBackend([
          [
            { type: 'chat', chat: { remoteId: 'd-anna', kind: 'direct', title: 'Anna', members: [ANNA] } },
            incoming('d-anna', msg('d-anna/1', 1, 'Hallo')),
            incoming('d-anna', msg('d-anna/2', 2, 'Ja', { fromSelf: true, sender: null })),
          ],
          [incoming('g-orga', msg('g-orga/1', 5, 'Wer bringt Salat?'))],
        ]);
        expect(isDeliveryBackend(backend)).toBe(true);
        const result = await receiveDeliveries(db, backend);
        expect(result.added).toBe(3);
        expect(result.accounts[0].batches).toBe(2);
        expect(result.accounts[0].caughtUp).toBe(true);
        rebuildConversations(db, {
          contacts: [{ uid: 'c-anna', name: 'Anna E.', org: null, emails: [], phones: ['+49 151 0000001'] }],
        });
        const all = listConversations(db);
        expect(all.length).toBe(2);
        const direct = getConversation(db, conv('d-anna'), { includeBodies: true });
        expect(direct?.conversation.title).toBe('Anna');
        expect(direct?.conversation.participants[0].contactUid).toBe('c-anna');
        expect(direct?.conversation.unreadCount).toBe(1);
        expect(direct?.messages.map((m) => m.bodyText).join('|')).toBe('Hallo|Ja');
        // A chat seen first through a message has no title yet, and is a group by its kind.
        const group = getConversation(db, conv('g-orga'));
        expect(group?.conversation.kind).toBe('group');
      } finally {
        db.close();
      }
    });

    // The point of counting a skip is that someone can read the count, and the only place anyone
    // reads it is the sync result this function returns. A backend that counts perfectly well and
    // a store that drops the count on the floor look identical from the terminal.
    await it("carries a backend's acknowledged-skip count into the result", async () => {
      const db = freshDb();
      try {
        const backend = fakeBackend([], {
          caughtUp: true,
          error: null,
          skipped: { 'phone-number-identity': 2, 'server-receipt': 7 },
        });
        const result = await receiveDeliveries(db, backend);
        const account = result.accounts[0];
        expect(account.skipped?.['phone-number-identity']).toBe(2);
        expect(account.skipped?.['server-receipt']).toBe(7);
        // Nothing was delivered, so this run looks like an empty inbox unless the count is there.
        expect(account.added).toBe(0);
        expect(account.batches).toBe(0);
      } finally {
        db.close();
      }
    });

    // A clean run must stay clean: an absent map, not an empty one, is what says "nothing was
    // dropped". An always-present `skipped: {}` would make every healthy account look like it
    // had something to hide.
    await it('leaves the count out entirely when the backend dropped nothing', async () => {
      const db = freshDb();
      try {
        const result = await receiveDeliveries(db, fakeBackend([]));
        expect(result.accounts[0].skipped).toBe(undefined);
      } finally {
        db.close();
      }
    });

    await it('keeps a known title when a later report has none, and merges peer addresses', async () => {
      const db = freshDb();
      try {
        await receiveDeliveries(
          db,
          fakeBackend([
            [
              {
                type: 'chat',
                chat: { remoteId: 'g-orga', kind: 'group', title: 'Sommerfest', members: null },
              },
            ],
          ]),
        );
        await receiveDeliveries(
          db,
          fakeBackend([
            [
              incoming('g-orga', msg('g-orga/1', 1, 'Hi')),
              {
                type: 'peer',
                peer: {
                  ...ANNA,
                  displayName: null,
                  addresses: [{ kind: 'whatsapp', value: '100000000000001@lid' }],
                },
              },
            ],
          ]),
        );
        expect(getConversation(db, conv('g-orga'))?.conversation.title).toBe('Sommerfest');
        const row = db
          .prepare('SELECT display_name, addresses_json FROM chat_peers WHERE peer_id = ?')
          .get('anna') as Record<string, unknown>;
        expect(row.display_name).toBe('Anna Example');
        expect(String(row.addresses_json).includes('+491510000001')).toBe(true);
        expect(String(row.addresses_json).includes('@lid')).toBe(true);
      } finally {
        db.close();
      }
    });

    await it('applies edits and deletions, stored or in the same batch', async () => {
      const db = freshDb();
      try {
        await receiveDeliveries(
          db,
          fakeBackend([
            [
              incoming('d-anna', msg('d-anna/1', 1, 'Tippfehler')),
              incoming('d-anna', msg('d-anna/2', 2, 'bleibt')),
            ],
          ]),
        );
        const result = await receiveDeliveries(
          db,
          fakeBackend([
            [
              {
                type: 'edit',
                chatRemoteId: 'd-anna',
                remoteId: 'd-anna/1',
                text: 'Korrigiert',
                editedAt: '2026-01-01T13:00:00.000Z',
              },
              incoming('d-anna', msg('d-anna/3', 3, 'gleich weg')),
              { type: 'delete', chatRemoteId: 'd-anna', remoteId: 'd-anna/3' },
              incoming('d-anna', msg('d-anna/4', 4, 'erste Fassung')),
              {
                type: 'edit',
                chatRemoteId: 'd-anna',
                remoteId: 'd-anna/4',
                text: 'zweite Fassung',
                editedAt: null,
              },
              { type: 'delete', chatRemoteId: 'd-anna', remoteId: 'd-anna/2' },
              // An edit of a message never stored changes nothing.
              { type: 'edit', chatRemoteId: 'd-anna', remoteId: 'd-anna/99', text: 'x', editedAt: null },
            ],
          ]),
        );
        expect(result.added).toBe(1);
        const shown = getConversation(db, conv('d-anna'), { includeBodies: true });
        expect(shown?.messages.map((m) => m.bodyText).join('|')).toBe('Korrigiert|zweite Fassung');
        expect(shown?.messages[0].editedAt).toBe('2026-01-01T13:00:00.000Z');
        expect(shown?.conversation.messageCount).toBe(2);
      } finally {
        db.close();
      }
    });

    await it('mirrors read state: read on another device, and read by the other side', async () => {
      const db = freshDb();
      try {
        await receiveDeliveries(
          db,
          fakeBackend([
            [
              incoming('d-anna', msg('d-anna/1', 1, 'a')),
              incoming('d-anna', msg('d-anna/2', 2, 'b')),
              incoming('d-anna', msg('d-anna/3', 3, 'c')),
              incoming('d-anna', msg('d-anna/4', 4, 'mine', { fromSelf: true, sender: null })),
              { type: 'chat-read', chatRemoteId: 'd-anna', unreadCount: 1 },
              { type: 'peer-read', chatRemoteId: 'd-anna', remoteIds: ['d-anna/4'] },
            ],
          ]),
        );
        let shown = getConversation(db, conv('d-anna'));
        expect(shown?.conversation.unreadCount).toBe(1);
        expect(shown?.messages.map((m) => (m.seen ? 1 : 0)).join('')).toBe('1101');
        expect(shown?.messages[3].readByPeer).toBe(true);
        await receiveDeliveries(
          db,
          fakeBackend([[{ type: 'chat-read', chatRemoteId: 'd-anna', unreadCount: 0 }]]),
        );
        shown = getConversation(db, conv('d-anna'));
        expect(shown?.conversation.unreadCount).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('applies a read receipt that names no chat, by the message alone', async () => {
      const db = freshDb();
      try {
        // A receipt that carries only the remote ids: the same own message in a direct chat and
        // in a group, plus somebody else's message that happens to carry the same remote id.
        await receiveDeliveries(
          db,
          fakeBackend([
            [
              incoming('d-anna', msg('own/1', 1, 'direkt', { fromSelf: true, sender: null })),
              incoming('g-1', msg('own/1', 1, 'in der Gruppe', { fromSelf: true, sender: null })),
              incoming('g-1', msg('own/2', 2, 'von anna', { fromSelf: false })),
            ],
          ]),
        );
        await receiveDeliveries(
          db,
          fakeBackend([[{ type: 'peer-read', chatRemoteId: null, remoteIds: ['own/1', 'own/9'] }]]),
        );
        const direct = getConversation(db, conv('d-anna'));
        const group = getConversation(db, conv('g-1'));
        expect(direct?.messages[0].readByPeer).toBe(true);
        expect(group?.messages[0].readByPeer).toBe(true);
        // A remote id no message carries is dropped, and a peer's message is never marked read.
        expect(group?.messages[1].readByPeer ?? false).toBe(false);
        expect(listConversations(db).length).toBe(2);
      } finally {
        db.close();
      }
    });

    await it('clears a chat, and deletes one with everything in it', async () => {
      const db = freshDb();
      try {
        await receiveDeliveries(
          db,
          fakeBackend([
            [
              incoming('d-anna', msg('d-anna/1', 1, 'a')),
              incoming('g-orga', msg('g-orga/1', 1, 'b')),
              { type: 'chat', chat: { remoteId: 'g-orga', kind: 'group', title: 'Orga', members: [ANNA] } },
            ],
          ]),
        );
        const result = await receiveDeliveries(
          db,
          fakeBackend([
            [
              { type: 'chat-cleared', chatRemoteId: 'd-anna' },
              { type: 'chat-deleted', chatRemoteId: 'g-orga' },
            ],
          ]),
        );
        expect(result.removed).toBe(2);
        expect(getConversation(db, conv('d-anna'))?.conversation.messageCount).toBe(0);
        expect(getConversation(db, conv('g-orga'))).toBe(null);
        const members = db
          .prepare('SELECT COUNT(*) AS n FROM chat_members WHERE conversation_id = ?')
          .get(conv('g-orga')) as {
          n: number;
        };
        expect(Number(members.n)).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('re-delivery of a message replaces its row instead of duplicating it', async () => {
      const db = freshDb();
      try {
        const batch = [incoming('d-anna', msg('d-anna/1', 1, 'einmal'))];
        await receiveDeliveries(db, fakeBackend([batch]));
        await receiveDeliveries(db, fakeBackend([batch]));
        expect(getConversation(db, conv('d-anna'))?.conversation.messageCount).toBe(1);
        const id = deliveredMessageId(BACKEND, ACCOUNT, 'd-anna', 'd-anna/1');
        expect(typeof id).toBe('string');
      } finally {
        db.close();
      }
    });

    await it('reports a session that ended early, and closes it', async () => {
      const db = freshDb();
      try {
        const log = { connects: 0, closed: 0 };
        const result = await receiveDeliveries(
          db,
          fakeBackend(
            [[incoming('d-anna', msg('d-anna/1', 1, 'a'))]],
            { caughtUp: false, error: 'logged out' },
            log,
          ),
        );
        expect(result.added).toBe(1);
        expect(result.errors).toBe(1);
        expect(result.failed).toBe(true);
        expect(result.accounts[0].error).toBe('logged out');
        expect(log.closed).toBe(1);
      } finally {
        db.close();
      }
    });

    await it('spends executions per batch, not per message (gjsify#1838 budget)', async () => {
      const db = freshDb();
      try {
        let runs = 0;
        const prepare = db.prepare.bind(db);
        (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
          const statement = prepare(sql);
          const run = statement.run.bind(statement);
          (statement as { run: typeof statement.run }).run = ((...args: Parameters<typeof statement.run>) => {
            runs++;
            return run(...args);
          }) as typeof statement.run;
          return statement;
        }) as typeof db.prepare;
        const events: DeliveryEvent[] = [];
        for (let i = 1; i <= 3000; i++)
          events.push(incoming(`d-${i % 30}`, msg(`d-${i % 30}/${i}`, i, `m${i}`)));
        const result = await receiveDeliveries(db, fakeBackend([events]));
        expect(result.added).toBe(3000);
        // 22 columns → 5 rows per statement: ~600 inserts, plus a fixed handful. One run per
        // message would be 3000+.
        expect(runs < 700).toBe(true);
      } finally {
        db.close();
      }
    });
    await it('merges a chat filed under a second id into the first, in one transaction', async () => {
      const db = freshDb();
      try {
        await receiveDeliveries(
          db,
          fakeBackend([
            [
              incoming('pn-anna', msg('M1', 1, 'eins')),
              incoming('pn-anna', msg('M2', 2, 'zwei')),
              { type: 'chat', chat: { remoteId: 'pn-anna', kind: 'direct', title: 'Anna', members: [ANNA] } },
            ],
          ]),
        );
        db.prepare(
          "UPDATE conversation_messages SET reply_to_client_id = 'origin-1' WHERE remote_id = 'M1'",
        ).run();
        await receiveDeliveries(
          db,
          fakeBackend([
            [
              incoming('pn-anna', msg('M3', 3, 'drei')),
              { type: 'chat-merged', from: 'pn-anna', into: 'lid-anna' },
              incoming('lid-anna', msg('M4', 4, 'vier')),
              { type: 'delete', chatRemoteId: 'lid-anna', remoteId: 'M2' },
              // A merge of a chat never stored changes nothing.
              { type: 'chat-merged', from: 'pn-nobody', into: 'lid-nobody' },
            ],
          ]),
        );
        expect(listConversations(db).length).toBe(1);
        expect(getConversation(db, conv('pn-anna'))).toBe(null);
        const merged = getConversation(db, conv('lid-anna'), { includeBodies: true });
        expect(merged?.conversation.title).toBe('Anna');
        expect(merged?.messages.map((m) => m.bodyText).join('|')).toBe('eins|drei|vier');
        expect(merged?.messages[0].replyToClientId).toBe('origin-1');
        const cursors = db.prepare('SELECT chat_id, last_seq FROM chat_cursors').all() as Array<
          Record<string, unknown>
        >;
        expect(cursors.map((c) => `${c.chat_id}:${c.last_seq}`).join(',')).toBe('lid-anna:4');
        const members = db.prepare('SELECT conversation_id FROM chat_members').all() as Array<
          Record<string, unknown>
        >;
        expect(members.every((m) => m.conversation_id === conv('lid-anna'))).toBe(true);
      } finally {
        db.close();
      }
    });

    // INSERT OR REPLACE deletes the row and inserts a new one, so every column the statement does
    // not name falls back to its default: a later delivery into the same chat silently reset the
    // cursor state another path had stored there.
    await it('keeps the stored cursor columns when a later delivery touches the same chat', async () => {
      const db = freshDb();
      try {
        await receiveDeliveries(db, fakeBackend([[incoming('d-anna', msg('d-anna/1', 1, 'Hallo'))]]));
        db.prepare(
          `UPDATE chat_cursors SET probe_seq = 7, last_cursor = 'cur-42', read_inbox_seq = 3, read_outbox_seq = 2
            WHERE conversation_id = ?`,
        ).run(conv('d-anna'));
        await receiveDeliveries(db, fakeBackend([[incoming('d-anna', msg('d-anna/2', 2, 'Nochmal'))]]));
        const row = db
          .prepare(
            `SELECT last_seq, probe_seq, last_cursor, read_inbox_seq, read_outbox_seq
               FROM chat_cursors WHERE conversation_id = ?`,
          )
          .get(conv('d-anna')) as Record<string, unknown>;
        expect(Number(row.last_seq)).toBe(2);
        expect(Number(row.probe_seq)).toBe(7);
        expect(String(row.last_cursor)).toBe('cur-42');
        expect(Number(row.read_inbox_seq)).toBe(3);
        expect(Number(row.read_outbox_seq)).toBe(2);
      } finally {
        db.close();
      }
    });

    // The daemon runs the echo adoption once per batch and never restarts, so a lookup that reads
    // back every echo the account ever wrote gets slower for as long as the daemon is up. Bounding
    // it to the batch's own ids must not change WHICH echo is adopted — hence both halves here.
    await it("adopts the batch's own local echo and reads back no other", async () => {
      const db = freshDb();
      try {
        const account = { id: ACCOUNT, identity: 'Me', provider: 'Fake' };
        const sent = (clientId: string, text: string) =>
          recordSentChatMessage(db, {
            backend: BACKEND,
            account,
            chatRemoteId: 'd-anna',
            clientId,
            text,
            sentAt: '2026-01-01T12:00:00.000Z',
          });
        const adopted = sent('oid-1', 'Bis gleich');
        // History: echoes of earlier sends the network's copy never came back for. A full scan
        // would read all of these on every batch; only `oid-1` is the one this batch names.
        const survivors = [sent('oid-2', 'Alt 2'), sent('oid-3', 'Alt 3'), sent('oid-4', 'Alt 4')];

        const sql: string[] = [];
        // A spread copy would drop the prototype's methods, and `receiveDeliveries` records a
        // per-account failure instead of throwing — so the run would look empty, not broken.
        const spy = new Proxy(db, {
          get(target, prop) {
            if (prop === 'prepare') {
              return (text: string) => {
                sql.push(text);
                return target.prepare(text);
              };
            }
            const value = Reflect.get(target, prop, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });

        // The delivered copy carries no body; the echo's text is what must survive the adoption.
        const result = await receiveDeliveries(
          spy,
          fakeBackend([
            [incoming('d-anna', msg('anna/9', 9, null, { fromSelf: true, sender: null, clientId: 'oid-1' }))],
          ]),
        );
        expect(result.accounts[0].error).toBe(null);
        expect(result.added).toBe(1);

        const echoRow = (id: string) =>
          db.prepare('SELECT body FROM conversation_messages WHERE id = ?').get(id) as
            | Record<string, unknown>
            | undefined;
        expect(echoRow(adopted.messageId)).toBe(undefined);
        expect(survivors.map((s) => String(echoRow(s.messageId)?.body)).join('|')).toBe('Alt 2|Alt 3|Alt 4');
        // The body came from the echo, since the delivered copy had none.
        const delivered = db
          .prepare(
            'SELECT body FROM conversation_messages WHERE backend = ? AND account_id = ? AND remote_id = ?',
          )
          .get(BACKEND, ACCOUNT, 'anna/9') as Record<string, unknown> | undefined;
        expect(String(delivered?.body)).toBe('Bis gleich');

        // The bound itself: the echo lookup names the batch's ids, so there is no `local:%` scan.
        expect(sql.some((text) => text.includes('remote_id LIKE'))).toBe(false);
        expect(sql.some((text) => text.includes('remote_id IN'))).toBe(true);
      } finally {
        db.close();
      }
    });
  });
};
