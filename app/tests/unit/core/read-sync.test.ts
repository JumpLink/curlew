import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DeliverySession, MessageBackend, MessageSender, SendingReadSync } from '@curlew/protocol';
import { MailSender } from '@curlew/imap/send';
import { GrantedXmppSession, mdsPublish, XmppQueryError, type XmppLink } from '@curlew/xmpp';
import { chatConversationId, rebuildConversations, syncChats } from '@curlew/store';
import { openIndex } from '../../../src/core/actions/index-sync.ts';

import { createDaemonSyncReadHandler } from '../../../src/core/actions/daemon.ts';
import { planReadSync, readSyncAllowed, syncReadState } from '../../../src/core/actions/read-sync.ts';
import { defaultConfig, parseConfig } from '../../../src/core/config.ts';
import {
  DAEMON_WIRE_VERSION,
  parseDaemonSyncReadReply,
  parseDaemonSyncReadRequest,
} from '../../../src/core/lib/daemon-bus.ts';
import { createReadSyncScheduler } from '../../../src/window/read-sync-scheduler.ts';
import { telegramFixture } from '../store/chat-fixtures.ts';

// Synthetic only: a fake sender per case, a temporary index and config, nothing on any network.

const ACCOUNT = 'telegram-42';
const CHAT = '1001';
const DIRECT = chatConversationId('telegram', ACCOUNT, CHAT);

const configWith = (ui: Record<string, unknown>) => parseConfig(JSON.stringify({ ui }));

interface Rig {
  dir: string;
  dbPath: string;
  configPath: string;
  writeLogPath: string;
}

async function withRig(ui: Record<string, unknown>, body: (rig: Rig) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-readsync-'));
  try {
    const dbPath = join(dir, 'index.db');
    const db = openIndex(dbPath);
    try {
      await syncChats(db, telegramFixture());
      rebuildConversations(db);
    } finally {
      db.close();
    }
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ ui }));
    await body({ dir, dbPath, configPath, writeLogPath: join(dir, 'writes.log') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeBackend(
  name: string,
  requests: SendingReadSync[],
  opened: { n: number },
  shares = false,
): MessageBackend {
  const sender = {
    features: { readSync: true },
    readSync: async (r: SendingReadSync) => {
      requests.push(r);
    },
    close: async () => {},
  } as unknown as MessageSender;
  return {
    manifest: { name, sendSharesReceiveState: shares },
    listAccounts: async () => [{ id: ACCOUNT, identity: ACCOUNT, provider: name }],
    openSender: async () => {
      opened.n += 1;
      return sender;
    },
  } as unknown as MessageBackend;
}

async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export default async () => {
  await describe('read-state sync to own devices (#441)', async () => {
    await it('is on by default and gates the two peer-visible networks on read receipts', async () => {
      expect(defaultConfig().ui.syncReadState !== false).toBe(true);
      const on = configWith({});
      expect(readSyncAllowed(on, 'matrix')).toBe(true);
      expect(readSyncAllowed(on, 'signal')).toBe(true);
      expect(readSyncAllowed(on, 'xmpp')).toBe(true);
      expect(readSyncAllowed(on, 'mail')).toBe(true);
      expect(readSyncAllowed(on, 'telegram')).toBe(false);
      expect(readSyncAllowed(on, 'whatsapp')).toBe(false);
      const receipts = configWith({ sendReadReceipts: true });
      expect(readSyncAllowed(receipts, 'telegram')).toBe(true);
      expect(readSyncAllowed(receipts, 'whatsapp')).toBe(true);
      const off = configWith({ syncReadState: false, sendReadReceipts: true });
      for (const name of ['matrix', 'signal', 'xmpp', 'mail', 'telegram', 'whatsapp']) {
        expect(readSyncAllowed(off, name)).toBe(false);
      }
    });

    await it('writes nothing to the network while the setting is off', async () => {
      await withRig({ syncReadState: false, sendReadReceipts: true }, async (rig) => {
        const requests: SendingReadSync[] = [];
        const opened = { n: 0 };
        const outcome = await syncReadState({
          accountId: ACCOUNT,
          conversationIds: [DIRECT],
          to: CHAT,
          frontend: 'window',
          dbPath: rig.dbPath,
          configPath: rig.configPath,
          writeLogPath: rig.writeLogPath,
          backend: fakeBackend('telegram', requests, opened),
        });
        expect(outcome).toBe('off');
        expect(opened.n).toBe(0);
        expect(requests.length).toBe(0);
      });
    });

    await it('holds Telegram back until read receipts are on, then sends the newest incoming message', async () => {
      await withRig({}, async (rig) => {
        const requests: SendingReadSync[] = [];
        const opened = { n: 0 };
        const params = {
          accountId: ACCOUNT,
          conversationIds: [DIRECT],
          to: CHAT,
          frontend: 'window' as const,
          dbPath: rig.dbPath,
          configPath: rig.configPath,
          writeLogPath: rig.writeLogPath,
          backend: fakeBackend('telegram', requests, opened),
        };
        expect(await syncReadState(params)).toBe('off');
        expect(opened.n).toBe(0);
        writeFileSync(rig.configPath, JSON.stringify({ ui: { sendReadReceipts: true } }));
        expect(await syncReadState(params)).toBe('synced');
        expect(requests.length).toBe(1);
        expect(requests[0].to).toBe(CHAT);
        expect(requests[0].target.fromSelf).toBe(false);
      });
    });

    await it('sends a private-by-nature network without read receipts', async () => {
      await withRig({}, async (rig) => {
        const requests: SendingReadSync[] = [];
        const outcome = await syncReadState({
          accountId: ACCOUNT,
          conversationIds: [DIRECT],
          to: CHAT,
          frontend: 'window',
          dbPath: rig.dbPath,
          configPath: rig.configPath,
          writeLogPath: rig.writeLogPath,
          backend: fakeBackend('matrix', requests, { n: 0 }),
        });
        expect(outcome).toBe('synced');
        expect(requests.length).toBe(1);
      });
    });

    await it('uses the daemon when it answers, and falls back to its own sender on an old or absent one', async () => {
      await withRig({}, async (rig) => {
        const requests: SendingReadSync[] = [];
        const opened = { n: 0 };
        const base = {
          accountId: ACCOUNT,
          conversationIds: [DIRECT],
          to: CHAT,
          frontend: 'window' as const,
          dbPath: rig.dbPath,
          configPath: rig.configPath,
          writeLogPath: rig.writeLogPath,
          backend: fakeBackend('signal', requests, opened, true),
        };
        const asked: unknown[] = [];
        const daemon = (reply: unknown) =>
          ({
            syncRead: async (r: unknown) => {
              asked.push(r);
              return reply;
            },
          }) as never;
        // Handled by the daemon on its open connection: no sender of our own.
        expect(
          await syncReadState({ ...base, daemon: daemon({ v: DAEMON_WIRE_VERSION, kind: 'synced' }) }),
        ).toBe('synced');
        expect(opened.n).toBe(0);
        expect(asked.length).toBe(1);
        // `null` is "no daemon" or an old one answering UnknownMethod: the direct sender does it.
        expect(await syncReadState({ ...base, daemon: daemon(null) })).toBe('synced');
        expect(opened.n).toBe(1);
        expect(requests.length).toBe(1);
        // A refusal surfaces to the caller, which logs it.
        const message = await failure(
          syncReadState({
            ...base,
            daemon: daemon({ v: DAEMON_WIRE_VERSION, kind: 'failed', message: 'boom' }),
          }),
        );
        expect(message).toBe('boom');
      });
    });

    await it('plans the newest incoming message of the conversation', async () => {
      await withRig({}, async (rig) => {
        const db = openIndex(rig.dbPath);
        try {
          const plan = planReadSync(db, [DIRECT]);
          expect(plan !== null).toBe(true);
          expect(plan?.target.fromSelf).toBe(false);
          expect(planReadSync(db, ['no-such-conversation'])).toBe(null);
        } finally {
          db.close();
        }
      });
    });

    await it('debounces per conversation and logs a failure instead of throwing', async () => {
      const timers = new Map<number, { run: () => void; ms: number }>();
      let next = 1;
      const log: string[] = [];
      const scheduler = createReadSyncScheduler(
        {
          set: (run, ms) => {
            const id = next++;
            timers.set(id, { run, ms });
            return id;
          },
          clear: (handle) => {
            timers.delete(handle as number);
          },
        },
        (line) => log.push(line),
      );
      let a = 0;
      let b = 0;
      scheduler.schedule('chat-a', async () => void a++);
      scheduler.schedule('chat-a', async () => void a++);
      scheduler.schedule('chat-b', async () => void b++);
      // The second schedule replaced the first: one pending per conversation, 2 s each.
      expect(timers.size).toBe(2);
      for (const t of timers.values()) expect(t.ms).toBe(2000);
      for (const t of timers.values()) t.run();
      expect(a).toBe(1);
      expect(b).toBe(1);
      timers.clear();
      scheduler.schedule('chat-c', async () => {
        throw new Error('offline');
      });
      [...timers.values()][0].run();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(log.length).toBe(1);
      expect(log[0].includes('offline')).toBe(true);
      timers.clear();
      scheduler.schedule('chat-d', async () => void a++);
      expect(timers.size).toBe(1);
      scheduler.cancelAll();
      expect(timers.size).toBe(0);
    });

    await it('builds the XMPP MDS item for one chat and skips quietly without PEP', async () => {
      const stanza = mdsPublish({
        chat: 'anna@example.org',
        stanzaId: 'sid-1',
        by: 'me@example.org',
        options: true,
      });
      const publish = stanza.getChild('pubsub')?.getChild('publish');
      expect(publish?.attrs.node).toBe('urn:xmpp:mds:displayed:0');
      const item = publish?.getChild('item');
      expect(item?.attrs.id).toBe('anna@example.org');
      const sid = item?.getChild('displayed')?.getChild('stanza-id');
      expect(sid?.attrs.id).toBe('sid-1');
      expect(sid?.attrs.by).toBe('me@example.org');
      expect(stanza.getChild('pubsub')?.getChild('publish-options') !== undefined).toBe(true);
      expect(
        mdsPublish({ chat: 'a@example.org', stanzaId: 's', by: 'me@example.org', options: false })
          .getChild('pubsub')
          ?.getChild('publish-options'),
      ).toBe(undefined);

      const permit = { account: 'xmpp-me', addresses: ['anna@example.org'] };
      const make = (error: XmppQueryError | null, sets: unknown[]) =>
        new GrantedXmppSession(
          {
            jid: 'me@example.org',
            pepSet: async (payload: unknown) => {
              sets.push(payload);
              if (error) throw error;
            },
          } as unknown as XmppLink,
          permit,
          () => 'id-1',
        );
      const none: unknown[] = [];
      await make(new XmppQueryError('service-unavailable'), none).markDisplayed('anna@example.org', 'sid-1');
      expect(none.length).toBe(1);
      const other = await failure(
        make(new XmppQueryError('forbidden'), []).markDisplayed('anna@example.org', 's'),
      );
      expect(other !== null).toBe(true);
      const ok: unknown[] = [];
      await make(null, ok).markDisplayed('anna@example.org', 'sid-1');
      expect(ok.length).toBe(1);
      // Only the chat the permit names.
      expect((await failure(make(null, []).markDisplayed('eve@example.org', 's'))) !== null).toBe(true);
    });

    await it('hands the IMAP marker the mailbox and UIDs, for the permitted address only', async () => {
      const calls: Array<[string, string, number[]]> = [];
      const sender = new MailSender(
        {} as never,
        { account: 'mail-me', addresses: ['anna@example.org'] },
        undefined,
        async (to, folder, uids) => {
          calls.push([to, folder, uids]);
        },
      );
      const sync = {
        to: 'anna@example.org',
        target: { remoteId: '9', fromSelf: false },
        sentAt: '2026-09-01T10:00:00Z',
      };
      await sender.readSync({ ...sync, folder: 'INBOX', uids: [9, 7] });
      expect(calls.length).toBe(1);
      expect(calls[0][1]).toBe('INBOX');
      expect(calls[0][2].join()).toBe('9,7');
      await sender.readSync({ ...sync, folder: 'INBOX', uids: [] });
      await sender.readSync({ ...sync });
      expect(calls.length).toBe(1);
      expect(
        (await failure(sender.readSync({ ...sync, to: 'eve@example.org', folder: 'INBOX', uids: [1] }))) !==
          null,
      ).toBe(true);
      expect(calls.length).toBe(1);
    });

    await it('parses the bus request and reply, and the daemon handler answers per gate', async () => {
      const wire = {
        v: DAEMON_WIRE_VERSION,
        backend: 'signal',
        account: 'signal-1',
        to: 'aci',
        target: { remoteId: 'x:1', fromSelf: false },
        sentAt: '2026-09-01T10:00:00Z',
      };
      expect(parseDaemonSyncReadRequest(JSON.stringify(wire)).account).toBe('signal-1');
      expect(
        (await failure(Promise.resolve().then(() => parseDaemonSyncReadRequest('{"v":8}')))) !== null,
      ).toBe(true);
      expect(parseDaemonSyncReadReply(JSON.stringify({ v: DAEMON_WIRE_VERSION, kind: 'synced' })).kind).toBe(
        'synced',
      );

      const requests: SendingReadSync[] = [];
      const sessions = new Map<string, DeliverySession>();
      let paused = false;
      const handler = createDaemonSyncReadHandler({
        log: () => {},
        sessions,
        isPaused: () => paused,
      } as never);
      expect((await handler(wire as never)).kind).toBe('not-followed');
      sessions.set('signal/signal-1', {
        openSender: async () =>
          ({
            features: { readSync: true },
            readSync: async (r: SendingReadSync) => void requests.push(r),
            close: async () => {},
          }) as unknown as MessageSender,
      } as unknown as DeliverySession);
      const reply = await handler(wire as never);
      expect(reply.kind).toBe('synced');
      expect(requests.length).toBe(1);
      expect(requests[0].uids).toBe(undefined);
      paused = true;
      expect((await handler(wire as never)).kind).toBe('refused');
    });
  });
};
