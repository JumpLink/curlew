import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ChatRequestLike,
  checkRequest,
  fromBase64,
  GroupNames,
  GroupsViolation,
  groupsFetch,
  groupsRefusal,
  GroupTitles,
  NS,
  ProtoWriter,
  SIGNAL_STORAGE_HOST,
  SignalProtocolStore,
  type StorageRequest,
  sendRefusal,
  storageRefusal,
} from '@curlew/signal';
import { SecretStore } from '@curlew/store';

import { ALICE_ACI, LIB, OWN_ACI, OWN_PNI } from './world.ts';

/**
 * A group's name: the two reads that fetch it, the gate in front of each, and the session half that
 * remembers what was learnt. The group service is played by libsignal's own SERVER operations — a
 * credential is really issued and a presentation really verified — so what is measured is that
 * curlew's requests are ones a real server accepts, not that they match a copy of its shape.
 * Everything is synthetic: random keys, made-up names.
 */

const DAY = 86_400;
const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unhex = (hex: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));

interface FakeGroup {
  masterKey: Uint8Array<ArrayBuffer>;
  title: string | null;
  version: number;
  member: boolean;
}

/** Signal's group service, with a credential endpoint and a storage endpoint that verify. */
class FakeGroupService {
  readonly secret = LIB.zk.ServerSecretParams.generate();
  private readonly ops = new LIB.zk.ServerZkAuthOperations(this.secret);
  private readonly groups = new Map<string, FakeGroup>();
  chatRequests: ChatRequestLike[] = [];
  storageRequests: StorageRequest[] = [];
  /** The next storage answers, as statuses, ahead of the real one. */
  failWith: number[] = [];

  publicParams(): Uint8Array {
    return this.secret.getPublicParams().serialize();
  }

  add(title: string | null, version = 1, member = true): FakeGroup {
    const masterKey = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
    const group = { masterKey, title, version, member };
    this.groups.set(this.idOf(masterKey), group);
    return group;
  }

  private publicOf(masterKey: Uint8Array<ArrayBuffer>) {
    return LIB.zk.GroupSecretParams.deriveFromMasterKey(
      new LIB.zk.GroupMasterKey(masterKey),
    ).getPublicParams();
  }

  private idOf(masterKey: Uint8Array<ArrayBuffer>): string {
    return toB64(this.publicOf(masterKey).serialize());
  }

  /** What curlew's chat connection reaches: only the credential endpoint answers. */
  readonly chat = async (request: ChatRequestLike) => {
    this.chatRequests.push(request);
    const match = /redemptionStartSeconds=(\d+)/.exec(request.path);
    if (!match) return { status: 404 };
    const start = Number(match[1]);
    const credentials = [0, 1, 2].map((i) => ({
      redemptionTime: start + i * DAY,
      credential: toB64(
        this.ops
          .issueAuthCredentialWithPniZkc(
            LIB.core.Aci.fromUuid(OWN_ACI),
            LIB.core.Pni.fromUuid(OWN_PNI),
            start + i * DAY,
          )
          .serialize(),
      ),
    }));
    const body = new TextEncoder().encode(JSON.stringify({ credentials, pni: `PNI:${OWN_PNI}` }));
    return { status: 200, body };
  };

  readonly storage = async (request: StorageRequest) => {
    this.storageRequests.push(request);
    const failure = this.failWith.shift();
    if (failure) return { status: failure, body: new Uint8Array() };
    const auth = request.headers.find(([name]) => name === 'Authorization')?.[1] ?? '';
    const [user, password] = atob(auth.replace(/^Basic /, '')).split(':');
    const publicParams = new LIB.zk.GroupPublicParams(unhex(user));
    // A real server refuses a presentation that does not verify for these group parameters.
    this.ops.verifyAuthCredentialPresentation(
      publicParams,
      new LIB.zk.AuthCredentialPresentation(unhex(password)),
    );
    const group = this.groups.get(toB64(publicParams.serialize()));
    if (!group || !group.member) return { status: 403, body: new Uint8Array() };
    const secret = LIB.zk.GroupSecretParams.deriveFromMasterKey(new LIB.zk.GroupMasterKey(group.masterKey));
    const cipher = new LIB.zk.ClientZkGroupCipher(secret);
    const inner = new ProtoWriter().uint(6, group.version);
    if (group.title !== null) {
      inner.bytes(2, cipher.encryptBlob(new ProtoWriter().string(1, group.title).finish()));
    }
    return { status: 200, body: new ProtoWriter().message(1, inner).finish() };
  };
}

function namesFor(service: FakeGroupService, now?: () => number): GroupNames {
  return new GroupNames({
    lib: LIB,
    account: { aci: OWN_ACI, deviceId: 2, password: 'x', registrationId: 1 },
    openChannel: async () => ({ fetch: groupsFetch(service.chat), close: async () => undefined }),
    storage: service.storage,
    serverPublicParams: service.publicParams(),
    now,
  });
}

export default async () => {
  await describe('signal: group names — the gates', async () => {
    const credentials = (extra = ''): ChatRequestLike => ({
      verb: 'GET',
      path: `/v1/certificate/auth/group?redemptionStartSeconds=100&redemptionEndSeconds=200${extra}`,
      headers: [],
    });

    await it('lets the credential read through the groups gate, with or without the format flags', () => {
      expect(groupsRefusal(credentials())).toBe(null);
      expect(groupsRefusal(credentials('&v101=true&zkcCredential=true'))).toBe(null);
    });

    await it('refuses everything else on a groups connection', () => {
      for (const request of [
        { verb: 'PUT', path: '/v1/certificate/auth/group?redemptionStartSeconds=1&redemptionEndSeconds=2' },
        {
          verb: 'GET',
          path: '/v1/certificate/auth/group?redemptionStartSeconds=1&redemptionEndSeconds=2&x=1',
        },
        { verb: 'GET', path: '/v2/groups' },
        { verb: 'GET', path: '/v2/groups/logs/3' },
        { verb: 'PUT', path: '/v2/groups' },
        { verb: 'PUT', path: `/v1/messages/${ALICE_ACI}` },
        { verb: 'GET', path: `/v2/keys/${ALICE_ACI}/*` },
        { verb: 'GET', path: '/v1/profile/' + ALICE_ACI },
        { verb: 'PUT', path: '/v2/keys?identity=aci' },
      ]) {
        expect(groupsRefusal({ ...request, headers: [] })).not.toBe(null);
      }
    });

    await it('throws before a refused request reaches the connection', async () => {
      let reached = 0;
      const gated = groupsFetch(async () => {
        reached++;
        return { status: 200 };
      });
      let refused = '';
      try {
        await gated({ verb: 'GET', path: '/v1/profile/x', headers: [] });
      } catch (err) {
        expect(err instanceof GroupsViolation).toBe(true);
        refused = (err as Error).message;
      }
      expect(refused).toContain('not part of reading a group');
      await gated(credentials());
      expect(reached).toBe(1);
    });

    await it('opens nothing on the link, sync or send gates', () => {
      for (const phase of ['link', 'sync'] as const) {
        let thrown = false;
        try {
          checkRequest(phase, credentials());
        } catch {
          thrown = true;
        }
        expect(thrown).toBe(true);
      }
      expect(sendRefusal(credentials(), [OWN_ACI])).not.toBe(null);
    });

    await it('allows one GET /v2/groups to the storage host and nothing else', () => {
      const host = SIGNAL_STORAGE_HOST;
      expect(storageRefusal({ verb: 'GET', host, path: '/v2/groups' }, host)).toBe(null);
      expect(storageRefusal({ verb: 'GET', host: 'example.invalid', path: '/v2/groups' }, host)).not.toBe(
        null,
      );
      expect(storageRefusal({ verb: 'PUT', host, path: '/v2/groups' }, host)).not.toBe(null);
      expect(storageRefusal({ verb: 'GET', host, path: '/v2/groups/logs/1' }, host)).not.toBe(null);
      expect(storageRefusal({ verb: 'GET', host, path: '/v2/groups/join/abc' }, host)).not.toBe(null);
    });
  });

  await describe('signal: group names — the fetch', async () => {
    await it('reads a name a real server would accept', async () => {
      const service = new FakeGroupService();
      const group = service.add('Climbing Tuesday', 4);
      const name = await namesFor(service).nameOf(group.masterKey);
      expect(name.title).toBe('Climbing Tuesday');
      expect(name.revision).toBe(4);
      expect(service.storageRequests[0].host).toBe(SIGNAL_STORAGE_HOST);
      expect(storageRefusal(service.storageRequests[0], SIGNAL_STORAGE_HOST)).toBe(null);
      const query = service.chatRequests[0].path;
      expect(query).toContain('v101=true');
      expect(query).toContain('zkcCredential=true');
    });

    await it('asks for the day credential once, however many groups it names', async () => {
      const service = new FakeGroupService();
      const names = namesFor(service);
      await names.nameOf(service.add('One').masterKey);
      await names.nameOf(service.add('Two').masterKey);
      expect(service.chatRequests.length).toBe(1);
      expect(service.storageRequests.length).toBe(2);
    });

    await it('asks again the next day', async () => {
      const service = new FakeGroupService();
      let now = Date.now();
      const names = namesFor(service, () => now);
      const group = service.add('Daily');
      await names.nameOf(group.masterKey);
      now += 1.5 * DAY * 1000;
      await names.nameOf(group.masterKey);
      expect(service.chatRequests.length).toBe(2);
    });

    await it('reads a group without a name as unnamed, and a group it left as unreadable', async () => {
      const service = new FakeGroupService();
      const names = namesFor(service);
      expect((await names.nameOf(service.add(null).masterKey)).title).toBe(null);
      expect((await names.nameOf(service.add('Secret', 1, false).masterKey)).title).toBe(null);
    });

    await it('does not authenticate for a group the master key does not match', async () => {
      const service = new FakeGroupService();
      const names = namesFor(service);
      const stranger = crypto.getRandomValues(new Uint8Array(32));
      expect((await names.nameOf(stranger)).title).toBe(null);
    });

    await it('throws on a refused credential and fetches a fresh one next time', async () => {
      const service = new FakeGroupService();
      const names = namesFor(service);
      const group = service.add('Again');
      service.failWith = [401];
      let message = '';
      try {
        await names.nameOf(group.masterKey);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('refused the credential');
      expect((await names.nameOf(group.masterKey)).title).toBe('Again');
      expect(service.chatRequests.length).toBe(2);
    });

    await it('stores the server public parameters Signal-Desktop ships', () => {
      expect(fromBase64('AMhf5ywV').length).toBe(6);
    });
  });

  await describe('signal: group names — the session', async () => {
    async function withStore(run: (store: SignalProtocolStore) => Promise<void>): Promise<void> {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-signal-groups-'));
      try {
        const file = SecretStore.open(join(dir, 'session.db'));
        try {
          await run(SignalProtocolStore.open(LIB, file));
        } finally {
          file.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    const run = <T>(work: () => Promise<T>): Promise<T> => work();
    const chatId = (n: number): string => `group:chat-${n}`;

    await it('turns a seen group into a chat event with its name', async () => {
      await withStore(async (store) => {
        const service = new FakeGroupService();
        const group = service.add('GNOME Design', 2);
        const titles = new GroupTitles(store, namesFor(service).nameOf, run);
        titles.seen(chatId(1), group.masterKey, 2);
        const events = await titles.resolve();
        expect(events.length).toBe(1);
        expect(events[0]).toStrictEqual({
          type: 'chat',
          chat: { remoteId: chatId(1), kind: 'group', title: 'GNOME Design', members: null },
        });
        expect(titles.problem).toBe(null);
      });
    });

    await it('writes the name to the session file but never the master key', async () => {
      await withStore(async (store) => {
        const service = new FakeGroupService();
        const group = service.add('Private Name', 3);
        const titles = new GroupTitles(store, namesFor(service).nameOf, run);
        titles.seen(chatId(1), group.masterKey, 3);
        await titles.resolve();
        const raw = store.get(NS.groups, chatId(1)) ?? '';
        expect(JSON.parse(raw).t).toBe('Private Name');
        expect(raw).not.toContain(toB64(group.masterKey));
        expect(store.pending).toBe(0);
      });
    });

    await it('does not ask again for a name it has, until the group moves on', async () => {
      await withStore(async (store) => {
        const service = new FakeGroupService();
        const group = service.add('Stable', 2);
        const titles = new GroupTitles(store, namesFor(service).nameOf, run);
        titles.seen(chatId(1), group.masterKey, 2);
        await titles.resolve();
        titles.seen(chatId(1), group.masterKey, 2);
        titles.seen(chatId(1), group.masterKey, null);
        expect((await titles.resolve()).length).toBe(0);
        expect(service.storageRequests.length).toBe(1);

        group.title = 'Renamed';
        group.version = 3;
        titles.seen(chatId(1), group.masterKey, 3);
        const events = await titles.resolve();
        expect(service.storageRequests.length).toBe(2);
        expect(events[0].type === 'chat' && events[0].chat.title).toBe('Renamed');
      });
    });

    await it('remembers across sessions through the file', async () => {
      await withStore(async (store) => {
        const service = new FakeGroupService();
        const group = service.add('Kept', 1);
        const first = new GroupTitles(store, namesFor(service).nameOf, run);
        first.seen(chatId(1), group.masterKey, 1);
        await first.resolve();
        const second = new GroupTitles(store, namesFor(service).nameOf, run);
        second.seen(chatId(1), group.masterKey, 1);
        expect((await second.resolve()).length).toBe(0);
        expect(service.storageRequests.length).toBe(1);
      });
    });

    await it('survives a failing group service: no event, one problem, no second try inside the window', async () => {
      await withStore(async (store) => {
        const service = new FakeGroupService();
        const group = service.add('Later', 1);
        service.failWith = [500, 500];
        let now = 1_000_000;
        const titles = new GroupTitles(store, namesFor(service).nameOf, run, {
          now: () => now,
          retryAfterMs: 1000,
        });
        titles.seen(chatId(1), group.masterKey, null);
        expect((await titles.resolve()).length).toBe(0);
        expect(titles.problem).toContain('could not be fetched');
        expect(titles.problem).not.toContain('Later');

        titles.seen(chatId(1), group.masterKey, null);
        expect((await titles.resolve()).length).toBe(0);
        expect(service.storageRequests.length).toBe(1);

        now += 2000;
        service.failWith = [];
        titles.seen(chatId(1), group.masterKey, null);
        const events = await titles.resolve();
        expect(events.length).toBe(1);
      });
    });

    await it('gives up on a lookup that never answers', async () => {
      await withStore(async (store) => {
        const titles = new GroupTitles(store, () => new Promise(() => undefined), run, { deadlineMs: 20 });
        titles.seen(chatId(1), new Uint8Array(32), null);
        expect((await titles.resolve()).length).toBe(0);
        expect(titles.problem).toContain('did not answer in time');
      });
    });

    await it('names at most perBatch groups at once and keeps the rest for the next batch', async () => {
      await withStore(async (store) => {
        const service = new FakeGroupService();
        const titles = new GroupTitles(store, namesFor(service).nameOf, run, { perBatch: 2 });
        for (let i = 0; i < 3; i++) titles.seen(chatId(i), service.add(`Group ${i}`).masterKey, null);
        expect((await titles.resolve()).length).toBe(2);
        expect((await titles.resolve()).length).toBe(1);
      });
    });
  });
};
