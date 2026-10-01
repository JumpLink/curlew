import { describe, expect, it } from '@gjsify/unit';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountPrompter, BackendContext, ChatBackend } from '@postbote/protocol';
import { isChatBackend, validateManifest } from '@postbote/protocol';
import {
  chatConversationId,
  getConversation,
  listConversations,
  rebuildConversations,
  SecretStore,
  syncChats,
} from '@postbote/store';
import type { TgMessage } from '@postbote/telegram';
import {
  API_HASH_ENV,
  API_ID_ENV,
  identityOf,
  peerAddresses,
  credentialsFromEnv,
  parseCredentials,
  PENDING_STALE_MS,
  refuseConfigCredentials,
  SecretStoreStorage,
  sweepPendingSessions,
  TELEGRAM_MANIFEST,
  TelegramBackend,
  TelegramChatSession,
  toChatInfo,
  toChatMessage,
} from '@postbote/telegram';
import { conversationsList, conversationsShow, openIndex } from '../../../src/core/actions/index.ts';
import { telegramFixture } from '../store/chat-fixtures.ts';
import { freshDb } from '../store/fixtures.ts';
import { fakeFactory, group, ME, tgMessage, user } from './fake-client.ts';

/**
 * The Telegram backend without Telegram: mapping of mtcute's shapes, the chat session over a fake
 * client, the session storage on postbote's SQLite, the login flow and what it leaves on disk,
 * and a full sync through the backend into the conversation view. All data is synthetic.
 */

const HASH = '0123456789abcdef0123456789abcdef';
const CREDENTIAL_ENV = { [API_ID_ENV]: '12345', [API_HASH_ENV]: HASH };
const ANNA = user(1001, 'Anna Example', { username: 'Anna_Example', phoneNumber: '491510000000' });
const BEN = user(1002, 'Ben Example');
const BOT = user(1003, 'Helper Bot', { username: 'helper_bot', isBot: true });
const ORGA = group(-1004001, 'Sommerfest Orga');
const NEWS = group(-1005000, 'Example News', 'channel', 'example_news');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'postbote-telegram-'));
}

/** Credentials from the environment by default; `env: {}` makes the login ask for them. */
function context(dir: string, env: Record<string, string | undefined> = CREDENTIAL_ENV): BackendContext {
  return { settings: {}, env, secretsDir: join(dir, 'secrets', 'telegram') };
}

function prompter(answers: string[]): AccountPrompter & { asked: string[]; notes: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const notes: string[] = [];
  return {
    asked,
    notes,
    async ask(label, options) {
      asked.push(`${label}${options?.secret ? ' (secret)' : ''}`);
      const next = queue.shift();
      if (next === undefined) throw new Error('no answer left');
      return next;
    },
    notify: (message) => notes.push(message),
  };
}

export default async () => {
  await describe('Telegram manifest', async () => {
    await it('is a valid server-archive chat manifest with truthful capabilities', async () => {
      expect(validateManifest(TELEGRAM_MANIFEST).length).toBe(0);
      expect(TELEGRAM_MANIFEST.syncModel).toBe('server-archive');
      expect(TELEGRAM_MANIFEST.capabilities.e2ee).toBe(false);
      expect(TELEGRAM_MANIFEST.capabilities.subject).toBe(false);
      expect(TELEGRAM_MANIFEST.capabilities.edits && TELEGRAM_MANIFEST.capabilities.readReceipts).toBe(true);
      expect(TELEGRAM_MANIFEST.addressKinds.join(',')).toBe('telegram,phone');
      expect(TELEGRAM_MANIFEST.terms?.summary.includes('api_id')).toBe(true);
    });
  });

  await describe('Telegram credentials', async () => {
    await it('validates a pair, never quoting a bad hash', async () => {
      expect(parseCredentials('777', HASH.toUpperCase()).apiHash).toBe(HASH);
      expect(() => parseCredentials('x', HASH)).toThrow(/api_id/);
      let message = '';
      try {
        parseCredentials(1, 'not-a-hash-secret-value');
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/32 hexadecimal/);
      expect(message.includes('not-a-hash-secret-value')).toBe(false);
    });

    await it('takes the environment as a whole pair or not at all', async () => {
      expect(credentialsFromEnv({})).toBe(null);
      expect(credentialsFromEnv(CREDENTIAL_ENV)?.apiId).toBe(12345);
      expect(() => credentialsFromEnv({ [API_ID_ENV]: '1' })).toThrow(/both/);
    });

    await it('refuses credentials in the config file — it is backed up in the clear', async () => {
      expect(() => refuseConfigCredentials({ apiHash: HASH })).toThrow(/do not belong in the config/);
      expect(() => refuseConfigCredentials({ apiId: 1 })).toThrow(/do not belong in the config/);
      refuseConfigCredentials({ somethingElse: true });
    });
  });

  await describe('Telegram mapping', async () => {
    await it('gives a user their id, handle and international phone number', async () => {
      const addresses = peerAddresses(ANNA).map((a) => `${a.kind}:${a.value}`);
      expect(addresses).toEqualArray(['telegram:1001', 'telegram:anna_example', 'phone:+491510000000']);
      // A channel has no user id to address; its public handle is its address.
      expect(peerAddresses(NEWS).map((a) => a.value)).toEqualArray(['example_news']);
      expect(peerAddresses(ORGA).length).toBe(0);
    });

    await it('maps dialogs to direct, group and broadcast chats with their read markers', async () => {
      const direct = toChatInfo({
        peer: ANNA,
        lastMessage: tgMessage(ANNA, 7, ANNA, 'x'),
        lastReadIngoing: 5,
        lastReadOutgoing: 6,
      });
      expect(direct.kind).toBe('direct');
      expect(direct.remoteId).toBe('1001');
      expect(direct.members[0].remoteId).toBe('1001');
      expect(direct.lastSeq).toBe(7);
      expect(direct.readInboxSeq).toBe(5);
      expect(direct.readOutboxSeq).toBe(6);
      expect(
        toChatInfo({ peer: ORGA, lastMessage: null, lastReadIngoing: 0, lastReadOutgoing: 0 }).kind,
      ).toBe('group');
      expect(
        toChatInfo({ peer: NEWS, lastMessage: null, lastReadIngoing: 0, lastReadOutgoing: 0 }).kind,
      ).toBe('broadcast');
      // Saved Messages is a chat with yourself: nobody else is in it.
      expect(
        toChatInfo({ peer: ME, lastMessage: null, lastReadIngoing: 0, lastReadOutgoing: 0 }).members.length,
      ).toBe(0);
    });

    await it('maps messages: own, attachments, link previews, replies, topics, service notices', async () => {
      const mine = toChatMessage(tgMessage(ANNA, 3, 'me', 'hi'));
      expect(mine?.fromSelf).toBe(true);
      expect(mine?.sender).toBe(null);
      expect(mine?.remoteId).toBe('1001/3');
      const photo = toChatMessage(tgMessage(ANNA, 4, ANNA, '', { media: { type: 'photo' } }));
      expect(photo?.hasAttachments).toBe(true);
      expect(photo?.text).toBe(null);
      const link = toChatMessage(tgMessage(ANNA, 5, ANNA, 'see', { media: { type: 'webpage' } }));
      expect(link?.hasAttachments).toBe(false);
      const topic = toChatMessage(
        tgMessage(ORGA, 20, BEN, 'im Thema', {
          replyToMessage: { id: 18, threadId: 15 },
          isTopicMessage: true,
          editDate: new Date('2026-08-01T12:00:00Z'),
        }),
      );
      expect(topic?.replyToRemoteId).toBe('-1004001/18');
      expect(topic?.threadRemoteId).toBe('-1004001/15');
      expect(topic?.editedAt).toBe('2026-08-01T12:00:00.000Z');
      expect(toChatMessage(tgMessage(ORGA, 21, BEN, '', { isService: true }))).toBe(null);
      const anonymous = toChatMessage(tgMessage(ORGA, 22, BEN, 'anon', { sender: { type: 'anonymous' } }));
      expect(anonymous?.sender).toBe(null);
      expect(anonymous?.fromSelf).toBe(false);
    });

    await it('never lists a phone number as the account identity', async () => {
      expect(identityOf(ME)).toBe('@me_example');
      expect(identityOf(user(9, 'Nur Name'))).toBe('Nur Name');
    });
  });

  await describe('TelegramChatSession', async () => {
    const history = new Map([
      [
        -1004001,
        [
          tgMessage(ORGA, 1, BEN, 'eins'),
          tgMessage(ORGA, 2, BEN, '', { isService: true }),
          tgMessage(ORGA, 3, ANNA, 'drei'),
          tgMessage(ORGA, 4, BEN, 'vier'),
        ],
      ],
    ]);

    await it('takes the newest window, oldest first, service notices out but counted in the cursor', async () => {
      const { create } = fakeFactory({ history });
      const client = create({
        credentials: { apiId: 1, apiHash: HASH },
        storage: new SecretStoreStorage(SecretStore.open(':memory:')),
      });
      const session = new TelegramChatSession(client);
      const page = await session.fetchHistory('-1004001', null, 3);
      expect(page.messages.map((m) => m.seq)).toEqualArray([3, 4]);
      expect(page.highestSeq).toBe(4);
      expect(page.exhausted).toBe(true);
    });

    const longChat = (count: number): Map<number, TgMessage[]> =>
      new Map([
        [ANNA.id, Array.from({ length: count }, (_, i) => tgMessage(ANNA, i + 1, ANNA, `m${i + 1}`))],
      ]);

    await it('takes a window larger than what Telegram returns per call, and does not claim the start', async () => {
      // Regression: Telegram returns at most 100 per `getHistory`, the default window is 200. The
      // short answer read as "nothing older exists", and `deletedBy` on a full scan then treated
      // everything below the newest 100 as deleted on the server — dropping messages that exist.
      const { create } = fakeFactory({ history: longChat(250) });
      const client = create({
        credentials: { apiId: 1, apiHash: HASH },
        storage: new SecretStoreStorage(SecretStore.open(':memory:')),
      });
      const page = await new TelegramChatSession(client).fetchHistory(String(ANNA.id), null, 200);
      expect(page.messages.length).toBe(200);
      expect(page.lowestSeq).toBe(51);
      expect(page.highestSeq).toBe(250);
      expect(page.reachedStart).toBe(false);
      expect(page.exhausted).toBe(true);
    });

    await it('claims the start of a chat only once Telegram has nothing older', async () => {
      const { create } = fakeFactory({ history: longChat(150) });
      const client = create({
        credentials: { apiId: 1, apiHash: HASH },
        storage: new SecretStoreStorage(SecretStore.open(':memory:')),
      });
      const page = await new TelegramChatSession(client).fetchHistory(String(ANNA.id), null, 200);
      expect(page.messages.length).toBe(150);
      expect(page.lowestSeq).toBe(1);
      expect(page.reachedStart).toBe(true);
    });

    await it('never reports a capped forward page as caught up', async () => {
      const { create } = fakeFactory({ history: longChat(250) });
      const client = create({
        credentials: { apiId: 1, apiHash: HASH },
        storage: new SecretStoreStorage(SecretStore.open(':memory:')),
      });
      const page = await new TelegramChatSession(client).fetchHistory(String(ANNA.id), 10, 150);
      expect(page.lowestSeq).toBe(11);
      expect(page.exhausted).toBe(false);
    });

    await it('asks for BOTH dialog folders, because mtcute leaves archived chats out by default', async () => {
      // Regression: `iterDialogs()` with no argument is mtcute's `archived: 'exclude'`, which asks
      // Telegram for the MAIN folder alone. An archived chat would then not be de-prioritised but
      // INVISIBLE — archiving a group would silently drop it from the index, with nothing to say
      // so. The fake serves the same list either way, so the assertion is on what was ASKED FOR.
      const { create } = fakeFactory({
        dialogs: [
          { peer: ANNA, lastMessage: null, lastReadIngoing: 0, lastReadOutgoing: 0 },
          { peer: ORGA, lastMessage: null, lastReadIngoing: 0, lastReadOutgoing: 0 },
        ],
      });
      const client = create({
        credentials: { apiId: 1, apiHash: HASH },
        storage: new SecretStoreStorage(SecretStore.open(':memory:')),
      });
      const chats = await new TelegramChatSession(client).listChats();
      expect(chats.map((c) => c.remoteId)).toEqualArray(['1001', '-1004001']);
      expect(client.dialogsParams[0]?.archived).toBe('keep');
      expect(client.calls.includes('iterDialogs:keep')).toBe(true);
    });

    await it('walks forward strictly after the cursor, asking mtcute for the offset + 1', async () => {
      const { create } = fakeFactory({ history });
      const client = create({
        credentials: { apiId: 1, apiHash: HASH },
        storage: new SecretStoreStorage(SecretStore.open(':memory:')),
      });
      const session = new TelegramChatSession(client);
      const page = await session.fetchHistory('-1004001', 1, 2);
      // #2 is a service notice: not a message, but the cursor moves past it.
      expect(page.messages.map((m) => m.seq)).toEqualArray([3]);
      expect(page.highestSeq).toBe(3);
      expect(page.exhausted).toBe(false);
      expect(client.calls.includes('getHistory:-1004001:rev@2:2')).toBe(true);
      const rest = await session.fetchHistory('-1004001', 3, 2);
      expect(rest.messages.map((m) => m.seq)).toEqualArray([4]);
      expect(rest.exhausted).toBe(true);
    });
  });

  await describe('Telegram session storage', async () => {
    await it('persists auth keys at once and everything else on save, as TEXT', async () => {
      const dir = tempDir();
      const path = join(dir, 's', 'telegram-1.db');
      try {
        const store = SecretStore.open(path);
        const storage = new SecretStoreStorage(store);
        await storage.driver.load();
        await storage.authKeys.set(2, new Uint8Array([0, 1, 254, 255]));
        // Written immediately — mtcute's contract for auth keys.
        const probe = SecretStore.open(path);
        expect(probe.load('mtcute.auth_keys').get('2')).toBe('AAH+/w==');
        probe.close();

        await storage.kv.set('self', new Uint8Array([7, 7]));
        await storage.peers.store({
          id: 1001,
          accessHash: '123456789',
          isMin: false,
          usernames: ['anna_example'],
          updated: 1,
          phone: '491510000000',
          complete: new Uint8Array([9, 8, 7]),
        });
        await storage.refMessages.store(1001, -1004001, 3);
        await storage.driver.save();
        store.close();
        expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
        expect((statSync(join(dir, 's')).mode & 0o777).toString(8)).toBe('700');

        const reopened = new SecretStoreStorage(SecretStore.open(path));
        await reopened.driver.load();
        expect([...((await reopened.authKeys.get(2)) ?? [])]).toEqualArray([0, 1, 254, 255]);
        expect([...((await reopened.kv.get('self')) ?? [])]).toEqualArray([7, 7]);
        const anna = await reopened.peers.getByUsername('anna_example');
        expect(anna?.accessHash).toBe('123456789');
        expect([...(anna?.complete ?? [])]).toEqualArray([9, 8, 7]);
        expect((await reopened.peers.getByPhone('491510000000'))?.id).toBe(1001);
        expect((await reopened.refMessages.getByPeer(1001))?.join(',')).toBe('-1004001,3');

        // Deletions are persisted too.
        await reopened.authKeys.deleteAll();
        await reopened.kv.delete('self');
        await reopened.driver.save();
        const after = SecretStore.open(path);
        expect(after.load('mtcute.auth_keys').size).toBe(0);
        expect(after.load('mtcute.kv').size).toBe(0);
        after.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('writes nothing when nothing changed', async () => {
      const store = SecretStore.open(':memory:');
      let applied = 0;
      const apply = store.apply.bind(store);
      store.apply = (changes) => {
        applied += changes.length;
        apply(changes);
      };
      const storage = new SecretStoreStorage(store);
      await storage.driver.load();
      await storage.kv.set('a', new Uint8Array([1]));
      await storage.driver.save();
      expect(applied).toBe(1);
      await storage.driver.save();
      expect(applied).toBe(1);
      store.close();
    });

    // mtcute's `asyncResettable` leaves `finished` FALSE when the wrapped promise rejects and
    // resets `_prepare` on every `disconnect()`, so a session is loaded again after a failed
    // connect. A `load()` that consumed its own "already loaded" flag before it read anything
    // would turn that retry into a silent no-op: the repositories stay EMPTY, mtcute reads the
    // empty DC set as a first run, negotiates a fresh auth key and overwrites the stored one —
    // a working session replaced by a new one, with no error anywhere.
    await it('a failed load does not consume the loaded state', async () => {
      const dir = tempDir();
      const path = join(dir, 's', 'telegram-1.db');
      try {
        const store = SecretStore.open(path);
        const storage = new SecretStoreStorage(store);
        const loadAll = store.loadAll.bind(store);
        let reads = 0;
        let failNext = true;
        store.loadAll = () => {
          reads++;
          if (failNext) {
            failNext = false;
            throw new Error('the session file is momentarily unreadable');
          }
          return loadAll();
        };
        store.apply([{ namespace: 'mtcute.kv', key: 'self', value: 'Bw==' }]);

        let threw = false;
        try {
          await storage.driver.load();
        } catch {
          threw = true;
        }
        expect(threw).toBe(true);
        expect(reads).toBe(1);

        // mtcute retries, and the retry must actually READ THE FILE again. A second call that
        // returned early would report success on empty repositories — mtcute reads the empty DC
        // set as a first run, negotiates a fresh auth key and overwrites the stored one.
        await storage.driver.load();
        expect(reads).toBe(2);
        expect([...((await storage.kv.get('self')) ?? [])]).toEqualArray([7]);
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // A row that cannot be decoded is skipped, not thrown on: one damaged peer row must not
    // make the whole account unusable, and re-authorizing is the honest outcome — the access
    // hash is gone, so that chat cannot be addressed any more, but the auth key survives and the
    // session still works. This mirrors how an undecodable temp auth key is already read as
    // "expired" (see `load()` above) rather than failing the connect.
    await it('skips a row it cannot decode instead of failing the whole session', async () => {
      const dir = tempDir();
      const path = join(dir, 's', 'telegram-1.db');
      try {
        const store = SecretStore.open(path);
        const goodPeer = JSON.stringify({
          accessHash: '123456789',
          isMin: false,
          usernames: ['anna_example'],
          updated: 1,
          complete: Buffer.from([9, 8, 7]).toString('base64'),
        });
        store.apply([
          { namespace: 'mtcute.peers', key: '1001', value: goodPeer },
          { namespace: 'mtcute.peers', key: '1002', value: '{not json' },
          { namespace: 'mtcute.ref_messages', key: '1001', value: 'also not json' },
          { namespace: 'mtcute.kv', key: 'self', value: 'Bw==' },
        ]);
        const storage = new SecretStoreStorage(store);

        await storage.driver.load();
        // The intact row is there, the damaged one is skipped, and the namespaces around them load.
        expect((await storage.peers.getByUsername('anna_example'))?.accessHash).toBe('123456789');
        expect(await storage.peers.getByUsername('nobody')).toBeNull();
        expect(await storage.refMessages.getByPeer(1001)).toBeNull();
        expect([...((await storage.kv.get('self')) ?? [])]).toEqualArray([7]);

        // And a save must not resurrect the skipped rows, nor delete the intact one.
        await storage.driver.save();
        const after = SecretStore.open(path);
        const peers = after.load('mtcute.peers');
        expect(peers.get('1001')).toBe(goodPeer);
        expect(peers.get('1002')).toBe('{not json');
        after.close();
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await describe('Telegram in the frontends', async () => {
    await it('the conversation actions (CLI and MCP) list and show chats with no branching', async () => {
      const dir = tempDir();
      const dbPath = join(dir, 'index.db');
      const configPath = join(dir, 'config.json');
      try {
        const db = openIndex(dbPath);
        await syncChats(db, telegramFixture());
        rebuildConversations(db);
        db.close();
        const listed = conversationsList({ dbPath, configPath, peopleOnly: true });
        expect(listed.count).toBe(2);
        expect(listed.indexedAt !== null).toBe(true);
        const shown = conversationsShow({
          id: listed.conversations[0].id,
          dbPath,
          configPath,
          includeBodies: true,
        });
        expect(
          shown.messages.every((m) => m.presentation === 'bubble' && typeof m.ref.remoteId === 'string'),
        ).toBe(true);
        expect(shown.messages.some((m) => typeof m.bodyText === 'string')).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await describe('TelegramBackend', async () => {
    await it('logs in: asks phone, code, password; keeps the session under the account id', async () => {
      const dir = tempDir();
      try {
        const factory = fakeFactory({});
        const backend = new TelegramBackend(context(dir), factory.create);
        const ask = prompter(['+49 170 0000000', '12345', 'correct horse']);
        const account = await backend.addAccount(ask);
        expect(account.id).toBe('telegram-42');
        expect(account.identity).toBe('@me_example');
        expect(ask.asked[2].endsWith('(secret)')).toBe(true);
        const files = readdirSync(context(dir).secretsDir);
        expect(files).toEqualArray(['telegram-42.db']);
        expect((statSync(join(context(dir).secretsDir, 'telegram-42.db')).mode & 0o777).toString(8)).toBe(
          '600',
        );
        const accounts = await backend.listAccounts();
        expect(accounts.map((a) => `${a.id} ${a.identity}`)).toEqualArray(['telegram-42 @me_example']);
        // The account list carries no phone number anywhere.
        expect(JSON.stringify(accounts).includes('4917')).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('leaves no file behind when the login fails', async () => {
      const dir = tempDir();
      try {
        const backend = new TelegramBackend(context(dir), fakeFactory({}).create);
        await expect(backend.addAccount(prompter(['+49 170 0000000', '12345', 'wrong']))).rejects.toThrow(
          /PASSWORD_HASH_INVALID/,
        );
        expect(readdirSync(context(dir).secretsDir).length).toBe(0);
        expect((await backend.listAccounts()).length).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('keeps an authorized session whose login rejects AFTER the sign-in', async () => {
      // The case a flag around the login promise gets wrong: mtcute records the user the moment
      // the server accepts the sign-in, and more runs after that. A throw there rejects `login()`
      // with a perfectly good session on disk — deciding on "did login() resolve?" would delete it
      // and cost the user another phone code.
      const dir = tempDir();
      const secrets = context(dir).secretsDir;
      try {
        const backend = new TelegramBackend(
          context(dir),
          fakeFactory({ failAfterSignIn: 'update manager failed' }).create,
        );
        await expect(
          backend.addAccount(prompter(['+49 170 0000000', '12345', 'correct horse'])),
        ).rejects.toThrow(/Telegram HAD authorized this session/);
        const left = readdirSync(secrets).filter((f) => f.endsWith('.pending.db'));
        expect(left.length).toBe(1);
        const store = SecretStore.open(join(secrets, left[0]));
        expect(store.load('mtcute.auth_keys').get('2')).toBe('AQIDBPr7');
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('keeps the authorized session when only the rename fails — the key is the only copy', async () => {
      // The rename can fail on a full disk, a read-only mount, or a path of the wrong kind left
      // behind by an earlier crash — always AFTER Telegram authorized us. The pending file then
      // holds the one and only auth key, so deleting it would throw away a login the user just
      // completed, and redoing it costs a phone code. It survives, and the error names it.
      //
      // A DIRECTORY at the target path is the one failure reproducible without a seam: rename(2)
      // onto a directory is EISDIR, so the move fails while everything before it succeeded.
      const dir = tempDir();
      const secrets = context(dir).secretsDir;
      try {
        const backend = new TelegramBackend(context(dir), fakeFactory({ loginAs: ME }).create);
        await backend.addAccount(prompter(['+49 170 0000000', '12345', 'correct horse']));
        // Now redo it with the target blocked; `ME.id` is 42, so this is where the rename lands.
        rmSync(join(secrets, 'telegram-42.db'), { force: true });
        mkdirSync(join(secrets, 'telegram-42.db'));
        await expect(
          backend.addAccount(prompter(['+49 170 0000000', '12345', 'correct horse'])),
        ).rejects.toThrow(/Telegram HAD authorized this session/);
        // Still there, still holding the key. Its name is not an account id, so it is not listed
        // as an account either (the sweep test above covers that).
        const left = readdirSync(secrets).filter((f) => f.endsWith('.pending.db'));
        expect(left.length).toBe(1);
        const store = SecretStore.open(join(secrets, left[0]));
        expect(store.load('mtcute.auth_keys').get('2')).toBe('AQIDBPr7');
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('refuses a config holding the api_hash, before asking anything', async () => {
      const dir = tempDir();
      try {
        const backend = new TelegramBackend(
          { ...context(dir), settings: { apiHash: HASH } },
          fakeFactory({}).create,
        );
        const ask = prompter([]);
        await expect(backend.addAccount(ask)).rejects.toThrow(/do not belong in the config/);
        expect(ask.asked.length).toBe(0);
        expect(existsSync(context(dir).secretsDir)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('without the environment, asks for api_id/api_hash first and keeps them in the session', async () => {
      const dir = tempDir();
      try {
        const noEnv = context(dir, {});
        const factory = fakeFactory({ dialogs: [] });
        const ask = prompter(['12345', HASH, '+49 170 0000000', '12345', 'correct horse']);
        await new TelegramBackend(noEnv, factory.create).addAccount(ask);
        expect(ask.asked[0]).toMatch(/api_id/);
        expect(ask.asked[1]).toMatch(/api_hash.*\(secret\)$/);
        expect(factory.clients[0].credentials.apiId).toBe(12345);
        // Stored in the 0600 session file, not the config; `sync` needs no environment.
        const store = SecretStore.open(join(noEnv.secretsDir, 'telegram-42.db'));
        expect(store.get('postbote.api', 'apiHash')).toBe(HASH);
        store.close();
        const session = await new TelegramBackend(noEnv, factory.create).connect('telegram-42');
        expect(factory.clients[1].credentials.apiHash).toBe(HASH);
        await session.close();
        // The environment still wins over what is stored.
        const other = { [API_ID_ENV]: '999', [API_HASH_ENV]: 'ffffffffffffffffffffffffffffffff' };
        await (await new TelegramBackend(context(dir, other), factory.create).connect('telegram-42')).close();
        expect(factory.clients[2].credentials.apiId).toBe(999);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('sweeps a stale pending login (it may hold a live key), keeps a fresh one, lists neither', async () => {
      const dir = tempDir();
      try {
        const secrets = context(dir).secretsDir;
        mkdirSync(secrets, { recursive: true });
        const stale = join(secrets, 'login-1000-1.pending.db');
        const fresh = join(secrets, 'login-2000-2.pending.db');
        writeFileSync(stale, '');
        writeFileSync(fresh, '');
        const old = (Date.now() - PENDING_STALE_MS - 60_000) / 1000;
        utimesSync(stale, old, old);
        const backend = new TelegramBackend(context(dir), fakeFactory({}).create);
        expect((await backend.listAccounts()).length).toBe(0);
        expect(existsSync(stale)).toBe(false);
        expect(existsSync(fresh)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('keeps a stale pending login that is SIGNED IN, drops the unsigned one and an orphan journal', async () => {
      const dir = tempDir();
      try {
        const secrets = context(dir).secretsDir;
        mkdirSync(secrets, { recursive: true });
        // (a) signed in: the only copy of a working session, however old it gets.
        const signedIn = join(secrets, 'login-1000-1.pending.db');
        const signInStore = SecretStore.open(signedIn);
        signInStore.apply([{ namespace: 'mtcute.kv', key: 'current_user', value: 'AQIDBPr7' }]);
        signInStore.close();
        // (b) NOT signed in: an auth key alone is proof of nothing (it exists from the connect).
        const unsigned = join(secrets, 'login-2000-2.pending.db');
        const unsignedStore = SecretStore.open(unsigned);
        unsignedStore.apply([{ namespace: 'mtcute.auth_keys', key: '2', value: 'AQIDBPr7' }]);
        unsignedStore.close();
        // (c) a journal whose database is already gone.
        const orphan = join(secrets, 'login-3000-3.pending.db-journal');
        writeFileSync(orphan, '');
        const old = (Date.now() - PENDING_STALE_MS - 60_000) / 1000;
        for (const path of [signedIn, unsigned, orphan]) utimesSync(path, old, old);

        sweepPendingSessions(secrets);
        expect(existsSync(signedIn)).toBe(true);
        expect(existsSync(unsigned)).toBe(false);
        expect(existsSync(orphan)).toBe(false);
        expect((await new TelegramBackend(context(dir), fakeFactory({}).create).listAccounts()).length).toBe(
          0,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('turns a revoked session into one clear re-login message', async () => {
      const dir = tempDir();
      try {
        await new TelegramBackend(context(dir), fakeFactory({}).create).addAccount(
          prompter(['+49 170 0000000', '12345', 'correct horse']),
        );
        const revoked = fakeFactory({ unauthorized: true });
        const backend = new TelegramBackend(context(dir), revoked.create);
        await expect(backend.connect('telegram-42')).rejects.toThrow(/accounts add telegram/);
        expect(revoked.clients[0].destroyed).toBe(1);
        await expect(backend.connect('telegram-7')).rejects.toThrow(/no Telegram session/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('syncs through the port into conversations — no Telegram-specific reads', async () => {
      const dir = tempDir();
      const db = freshDb();
      try {
        await new TelegramBackend(context(dir), fakeFactory({}).create).addAccount(
          prompter(['+49 170 0000000', '12345', 'correct horse']),
        );
        const script = {
          dialogs: [
            {
              peer: ORGA,
              lastMessage: tgMessage(ORGA, 12, ANNA, 'x'),
              lastReadIngoing: 12,
              lastReadOutgoing: 0,
            },
            {
              peer: ANNA,
              lastMessage: tgMessage(ANNA, 3, ANNA, 'x'),
              lastReadIngoing: 2,
              lastReadOutgoing: 2,
            },
            {
              peer: NEWS,
              lastMessage: tgMessage(NEWS, 500, NEWS, 'x'),
              lastReadIngoing: 0,
              lastReadOutgoing: 0,
            },
          ],
          history: new Map([
            [
              ANNA.id,
              [
                tgMessage(ANNA, 1, ANNA, 'Kommst du am Samstag?'),
                tgMessage(ANNA, 2, 'me', 'Ja, gerne'),
                tgMessage(ANNA, 3, ANNA, 'Super', { media: { type: 'photo' } }),
              ],
            ],
            [
              ORGA.id,
              [
                tgMessage(ORGA, 10, BEN, 'Wer bringt Salat?'),
                tgMessage(ORGA, 11, BOT, 'Umfrage'),
                tgMessage(ORGA, 12, ANNA, 'Ich'),
              ],
            ],
            [NEWS.id, [tgMessage(NEWS, 500, NEWS, 'Neue Ausgabe')]],
          ]),
        };
        const factory = fakeFactory(script);
        const backend: ChatBackend = new TelegramBackend(context(dir), factory.create);
        expect(isChatBackend(backend)).toBe(true);
        const result = await syncChats(db, backend);
        expect(result.added).toBe(7);
        // Asserted HERE and not only in the session unit test: this is the path that goes through
        // `withStoreClose`, and a forwarder that dropped the argument would leave the unit test
        // green while production silently stopped asking for the archive folder.
        expect(factory.clients.at(-1)?.dialogsParams[0]?.archived).toBe('keep');
        rebuildConversations(db, {
          contacts: [{ uid: 'c-anna', name: 'Anna E.', org: null, emails: [], phones: ['+49 151 0000000'] }],
        });
        const all = listConversations(db);
        expect(all.length).toBe(3);
        expect(all.every((c) => c.backend === 'telegram' && c.accountId === 'telegram-42')).toBe(true);
        const direct = getConversation(db, chatConversationId('telegram', 'telegram-42', '1001'));
        expect(direct?.conversation.participants[0].contactUid).toBe('c-anna');
        expect(direct?.conversation.unreadCount).toBe(1);
        expect(direct?.messages.map((m) => m.presentation).join(',')).toBe('bubble,bubble,bubble');
        const people = listConversations(db, { peopleOnly: true });
        expect(people.some((c) => c.title === 'Example News')).toBe(false);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    /**
     * `capabilities.edits` is a promise a frontend may act on, so it is asserted HERE, against the
     * path that has to make it true — not as a bare field check next to the other manifest
     * assertions. Nothing reads `capabilities` today, which is exactly why a wrong value would
     * go unnoticed: the manifest is the only place that states it, and this is the only place
     * that can catch it being a lie.
     *
     * Telegram has no `ChatHistoryPage.edits` and no `revisions()`: mtcute's `getHistory` returns
     * each message's CURRENT text, so an edit only reaches the index when the window is re-read.
     * That makes the claim conditional on `--full-scan` — asserted here, so nobody "simplifies"
     * the full-scan rewrite and leaves a manifest that promises edits it no longer delivers.
     */
    await it('delivers an edited message — the promise `capabilities.edits` makes', async () => {
      const dir = tempDir();
      const db = freshDb();
      try {
        await new TelegramBackend(context(dir), fakeFactory({}).create).addAccount(
          prompter(['+49 170 0000000', '12345', 'correct horse']),
        );
        const history = new Map([
          [
            ANNA.id,
            [
              tgMessage(ANNA, 1, ANNA, 'Kommst du am Samstag?'),
              tgMessage(ANNA, 2, 'me', 'Ja, gerne'),
              tgMessage(ANNA, 3, ANNA, 'Super', { media: { type: 'photo' } }),
            ],
          ],
        ]);
        const dialogs = [
          {
            peer: ANNA,
            lastMessage: tgMessage(ANNA, 3, ANNA, 'Super'),
            lastReadIngoing: 2,
            lastReadOutgoing: 2,
          },
        ];
        const factory = fakeFactory({ dialogs, history });
        const backend: ChatBackend = new TelegramBackend(context(dir), factory.create);
        const direct = chatConversationId('telegram', 'telegram-42', '1001');

        await syncChats(db, backend);
        expect(getConversation(db, direct, { includeBodies: true })?.messages[0]?.bodyText).toBe(
          'Kommst du am Samstag?',
        );

        // Anna edits her first message. The id and the date are unchanged — only the text and
        // `editDate` — so a forward walk (which asks for `seq > afterSeq`) can never see it.
        const edited = history.get(ANNA.id);
        if (!edited) throw new Error('fixture history missing');
        edited[0] = {
          ...edited[0],
          text: 'Kommst du am Sonntag?',
          editDate: new Date(Date.UTC(2026, 7, 1, 11, 0, 0)),
        };

        // Without a full scan the stored text stays: the message is not new, so nothing re-reads it.
        await syncChats(db, backend);
        expect(getConversation(db, direct, { includeBodies: true })?.messages[0]?.bodyText).toBe(
          'Kommst du am Samstag?',
        );

        await syncChats(db, backend, { fullScan: true });
        const first = getConversation(db, direct, { includeBodies: true })?.messages[0];
        expect(first?.bodyText).toBe('Kommst du am Sonntag?');
        expect(first?.editedAt).toBe('2026-08-01T11:00:00.000Z');
        // The edit replaces the row, it does not add a second copy of the message.
        expect(getConversation(db, direct)?.messages.length).toBe(3);

        // And the claim the manifest makes is the one that was just proved.
        expect(TELEGRAM_MANIFEST.capabilities.edits).toBe(true);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
