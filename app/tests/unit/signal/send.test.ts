import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountPrompter, SendPermit } from '@curlew/protocol';
import { isSendBackend } from '@curlew/protocol';
import {
  accountIdFor,
  type ChatRequestLike,
  type ChatResponseLike,
  checkRequest,
  type Content,
  decodeContent,
  EnvelopeType,
  fromBase64,
  sendFetch,
  sendRefusal,
  sessionPath,
  SIGNAL_MANIFEST,
  SIGNAL_MAX_MESSAGE_BYTES,
  SignalBackend,
  type SignalBackendOptions,
  SignalProtocolStore,
  toBase64,
  unpadPlaintext,
} from '@curlew/signal';
import {
  chatConversationId,
  getConversation,
  rebuildConversations,
  receiveDeliveries,
  SecretStore,
  takeReceiveLease,
} from '@curlew/store';
import * as Signal from '@signalapp/libsignal-client';

import { openIndex } from '../../../src/core/actions/index.ts';
import { sendMessage } from '../../../src/core/actions/send.ts';
import { withSendGateGrants } from '../../../src/frontends/mcp/tools/send.ts';
import { Party } from './stores.ts';
import {
  ALICE_ACI,
  CAROL_ACI,
  context,
  directEnvelope,
  FakeServer,
  introduce,
  LIB,
  OUR_DEVICE,
  OWN_ACI,
  ourAddress,
  Phone,
  TrustRoot,
} from './world.ts';

/**
 * The Signal send path without Signal's servers: the grant, the per-permit gate, the multi-device
 * fan-out, the sync transcript that puts the message on the phone, the device-list corrections
 * (409/410), the safety-number refusal, the byte limit and the receive lease that keeps a send and
 * the daemon off the same ratchet.
 *
 * The fake server is not a script: every copy curlew PUTs is DECRYPTED by the recipient device it
 * was addressed to, with libsignal, and the test reads the decrypted `Content`. So "the message
 * arrived" means the recipient could actually read it — a wrong device, a wrong session or a
 * ciphertext for somebody else fails here rather than passing a shape check. Only a ciphertext the
 * server ANSWERED 2xx is decrypted, because a ratchet step the server rejected never happened for
 * the recipient either.
 *
 * All identities, accounts and messages are synthetic; nothing reads the real Signal session.
 */

const ACCOUNT = accountIdFor(OWN_ACI);

/** Short names for the ACIs in the assertions, so a device list reads as `alice.1,self.3`. */
const NAMES: Record<string, string> = { [ALICE_ACI]: 'alice', [OWN_ACI]: 'self', [CAROL_ACI]: 'carol' };
const label = (serviceId: string, deviceId: number): string => `${NAMES[serviceId] ?? serviceId}.${deviceId}`;

/** One bundle as `GET /v2/keys/{serviceId}/*` returns it; a local copy of the wire shape. */
interface DeviceBundleJson {
  deviceId: number;
  registrationId: number;
  preKey: { keyId: number; publicKey: string };
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  pqPreKey: { keyId: number; publicKey: string; signature: string };
}

/** One encrypted copy for one device, as `PUT /v1/messages/{serviceId}` carries it. */
interface OutgoingMessageJson {
  type: number;
  destinationDeviceId: number;
  destinationRegistrationId: number;
  content: string;
}

interface PutBody {
  messages: OutgoingMessageJson[];
  timestamp: number;
  online: boolean;
  urgent: boolean;
}

/** What one device received, after it decrypted the copy addressed to it. */
interface Delivered {
  to: string;
  registrationId: number;
  type: number;
  content: Content;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'curlew-signal-send-'));
}

function prompter(): AccountPrompter {
  return { ask: async () => '', notify: () => undefined };
}

/** Link curlew's device through the scripted phone, as `signal.test.ts` does. */
async function link(dir: string): Promise<Phone> {
  const phone = new Phone();
  await new SignalBackend(context(dir), { lib: LIB, linkNetwork: () => phone.network() }).addAccount(
    prompter(),
  );
  return phone;
}

const req = (verb: string, path: string): ChatRequestLike => ({ verb, path, headers: [] });

const json = (status: number, value: unknown): ChatResponseLike => ({
  status,
  body: new TextEncoder().encode(JSON.stringify(value)),
});

/** A device's published keys, in the wire shape, from the keys it generated for its bundle. */
async function bundleJson(party: Party): Promise<DeviceBundleJson> {
  const bundle = await party.bundle();
  const preKey = bundle.preKeyPublic();
  const preKeyId = bundle.preKeyId();
  if (!preKey || preKeyId === null) throw new Error('a test bundle always carries a one-time pre-key');
  return {
    deviceId: bundle.deviceId(),
    registrationId: bundle.registrationId(),
    preKey: { keyId: preKeyId, publicKey: toBase64(preKey.serialize()) },
    signedPreKey: {
      keyId: bundle.signedPreKeyId(),
      publicKey: toBase64(bundle.signedPreKeyPublic().serialize()),
      signature: toBase64(bundle.signedPreKeySignature()),
    },
    pqPreKey: {
      keyId: bundle.kyberPreKeyId(),
      publicKey: toBase64(bundle.kyberPreKeyPublic().serialize()),
      signature: toBase64(bundle.kyberPreKeySignature()),
    },
  };
}

/** Decrypt one copy as the device it was addressed to, and read the `Content` out of it. */
async function decryptFor(party: Party, message: OutgoingMessageJson): Promise<Content> {
  const bytes = fromBase64(message.content);
  const padded =
    message.type === EnvelopeType.PREKEY_MESSAGE
      ? await Signal.signalDecryptPreKey(
          Signal.PreKeySignalMessage.deserialize(bytes),
          ourAddress(),
          party.address,
          party.sessions,
          party.identity,
          party.preKeys,
          party.signedPreKeys,
          party.kyberPreKeys,
        )
      : await Signal.signalDecrypt(
          Signal.SignalMessage.deserialize(bytes),
          ourAddress(),
          party.address,
          party.sessions,
          party.identity,
        );
  return decodeContent(unpadPlaintext(padded));
}

/**
 * One ACI with its devices. Every device of one account shares ONE identity key — that is what a
 * safety number is — so a reinstall is a second `Contact` with a fresh key, and a replaced session
 * is a `rotate`: new pre-keys and an empty session store under the SAME key.
 */
class Contact {
  readonly aci: string;
  readonly identity: Signal.PrivateKey;
  readonly devices = new Map<number, Party>();

  constructor(aci: string, identity: Signal.PrivateKey = Signal.PrivateKey.generate()) {
    this.aci = aci;
    this.identity = identity;
  }

  add(deviceId: number, registrationId = 100 + deviceId): Party {
    return this.put(new Party(this.aci, deviceId, registrationId, this.identity));
  }

  put(party: Party): Party {
    this.devices.set(party.address.deviceId(), party);
    return party;
  }

  rotate(deviceId: number): Party {
    const old = this.devices.get(deviceId);
    if (!old) throw new Error(`no device ${deviceId} to rotate`);
    return this.put(new Party(this.aci, deviceId, old.identity.registrationId, this.identity));
  }

  /** The devices in the order the server lists them. */
  ordered(): Party[] {
    return [...this.devices.keys()].sort((a, b) => a - b).map((id) => this.devices.get(id)!);
  }
}

/**
 * Signal's two send endpoints, as a sender reaches them: the pre-key bundles and the message PUT.
 *
 * A PUT is answered 409 when the addressed devices do not match the ones this server lists — which
 * is derived, never scripted, so a fan-out bug cannot be hidden by a lenient fake. `stale` scripts
 * the one case a client cannot see coming (410: the recipient replaced a session), `putStatus` a
 * raw failure, `alwaysMismatch` a server that never agrees.
 */
class SendServer {
  readonly contacts = new Map<string, Contact>();
  readonly requests: Array<{ verb: string; path: string; body: unknown }> = [];
  readonly delivered: Delivered[] = [];
  /** The permitted service ids each `openSender` built its gate from. */
  readonly opened: string[][] = [];
  /** Devices that answer the next PUT with 410 and get fresh keys, once. */
  readonly stale = new Map<string, number[]>();
  /** A raw failure status for the next PUT to this service id, once. */
  readonly putStatus = new Map<string, number>();
  alwaysMismatch = false;
  /** One bundle per device: a device's published keys do not change because they were read twice. */
  private readonly bundles = new WeakMap<Party, DeviceBundleJson>();

  add(contact: Contact): Contact {
    this.contacts.set(contact.aci, contact);
    return contact;
  }

  /** Forget what was recorded, keeping the sessions — for a second send with a clean ledger. */
  reset(): void {
    this.requests.length = 0;
    this.delivered.length = 0;
  }

  /** The `sendChannel` a backend is built with: the gate from `guard.ts`, then this server. */
  channel(): NonNullable<SignalBackendOptions['sendChannel']> {
    return async (_account, recipients) => {
      this.opened.push([...recipients]);
      return {
        fetch: sendFetch((request) => this.answer(request), recipients),
        close: async () => undefined,
      };
    };
  }

  private async answer(request: ChatRequestLike): Promise<ChatResponseLike> {
    const path = request.path.split('?')[0];
    const body = request.body ? (JSON.parse(new TextDecoder().decode(request.body)) as unknown) : null;
    this.requests.push({ verb: request.verb, path, body });
    const keys = /^\/v2\/keys\/([^/]+)\/\*$/.exec(path);
    if (request.verb === 'GET' && keys) return this.keysOf(keys[1]);
    const send = /^\/v1\/messages\/([^/]+)$/.exec(path);
    if (request.verb === 'PUT' && send) return this.put(send[1], body as PutBody);
    return { status: 404 };
  }

  private async keysOf(serviceId: string): Promise<ChatResponseLike> {
    const contact = this.contacts.get(serviceId);
    if (!contact) return { status: 404 };
    const devices: DeviceBundleJson[] = [];
    for (const party of contact.ordered()) {
      const cached = this.bundles.get(party);
      const bundle = cached ?? (await bundleJson(party));
      if (!cached) this.bundles.set(party, bundle);
      devices.push(bundle);
    }
    return json(200, { identityKey: toBase64(contact.identity.getPublicKey().serialize()), devices });
  }

  private async put(serviceId: string, body: PutBody): Promise<ChatResponseLike> {
    const forced = this.putStatus.get(serviceId);
    if (forced !== undefined) {
      this.putStatus.delete(serviceId);
      return { status: forced };
    }
    if (this.alwaysMismatch) return json(409, { missingDevices: [7] });
    const contact = this.contacts.get(serviceId);
    if (!contact) return { status: 404 };

    const stale = this.stale.get(serviceId);
    if (stale !== undefined) {
      this.stale.delete(serviceId);
      for (const deviceId of stale) if (contact.devices.has(deviceId)) contact.rotate(deviceId);
      return json(410, { staleDevices: stale });
    }

    // A sender never writes to the device it is: the own fan-out has to leave curlew out.
    const expected = contact
      .ordered()
      .map((party) => party.address.deviceId())
      .filter((deviceId) => !(serviceId === OWN_ACI && deviceId === OUR_DEVICE));
    const addressed = body.messages.map((message) => message.destinationDeviceId);
    const missingDevices = expected.filter((deviceId) => !addressed.includes(deviceId));
    const extraDevices = addressed.filter((deviceId) => !expected.includes(deviceId));
    if (missingDevices.length > 0 || extraDevices.length > 0) {
      return json(409, {
        ...(missingDevices.length > 0 ? { missingDevices } : {}),
        ...(extraDevices.length > 0 ? { extraDevices } : {}),
      });
    }

    for (const message of body.messages) {
      const party = contact.devices.get(message.destinationDeviceId)!;
      this.delivered.push({
        to: label(serviceId, message.destinationDeviceId),
        registrationId: message.destinationRegistrationId,
        type: message.type,
        content: await decryptFor(party, message),
      });
    }
    return json(200, {});
  }
}

interface Rig {
  dir: string;
  configPath: string;
  dbPath: string;
  accountId: string;
  backend: SignalBackend;
  phone: Phone;
  server: SendServer;
  /** The receive side, for the echo-replacement case. */
  inbox: FakeServer;
  alice: Contact;
  own: Contact;
}

const grant = (capability: string, address: string) => ({
  capability,
  target: `${ACCOUNT}/${address}`,
});

const GRANTED = { grants: [grant('signal.send', ALICE_ACI)] };
const GRANTED_SELF = { grants: [grant('signal.send', OWN_ACI)] };

/**
 * A linked account in a temporary directory, a config, the send server and a backend over both.
 *
 * Alice has two devices (1 and 4) and the account has three: the phone, curlew itself — listed,
 * because the server lists every device, and never written to — and one more linked device.
 */
async function withRig<T>(config: unknown, body: (rig: Rig) => Promise<T>): Promise<T> {
  const dir = tempDir();
  try {
    const phone = await link(dir);
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));

    const server = new SendServer();
    const alice = server.add(new Contact(ALICE_ACI));
    alice.add(1, 101);
    alice.add(4, 104);
    const own = server.add(new Contact(OWN_ACI, phone.identity));
    own.put(phone.device);
    own.add(OUR_DEVICE);
    own.add(3, 103);

    const inbox = new FakeServer();
    const trust = new TrustRoot();
    const backend = new SignalBackend(context(dir), {
      lib: LIB,
      trustRoots: trust.publicKeys,
      connector: () => inbox.connector(),
      sendChannel: server.channel(),
      download: async () => {
        throw new Error('no CDN in tests');
      },
      receiver: { maxMs: 5_000 },
    });
    return await body({
      dir,
      configPath,
      dbPath: join(dir, 'index.db'),
      accountId: ACCOUNT,
      backend,
      phone,
      server,
      inbox,
      alice,
      own,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Start a session from `party` to curlew's device, off the session file, so it can encrypt an
 * envelope to us. Where a send comes first, curlew's own fan-out does this: the pre-key message it
 * PUTs starts the session when the party decrypts it. Where nothing was sent yet, this does.
 */
async function introduceTo(rig: Rig, party: Party): Promise<void> {
  const file = SecretStore.open(sessionPath(context(rig.dir).secretsDir, rig.accountId));
  try {
    await introduce(party, SignalProtocolStore.open(LIB, file));
  } finally {
    file.close();
  }
}

const send = (rig: Rig, to: string, text: string) =>
  sendMessage({
    accountId: rig.accountId,
    to,
    text,
    frontend: 'cli',
    dbPath: rig.dbPath,
    configPath: rig.configPath,
    writeLogPath: join(rig.dir, 'writes.log'),
    backend: rig.backend,
  });

async function refused(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

function threw(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

export default async () => {
  await describe('Signal sending', async () => {
    await it('is a send backend whose handle talks to nobody until it sends', async () => {
      await withRig(GRANTED, async (rig) => {
        expect(isSendBackend(rig.backend)).toBe(true);
        // The ratchet lives in the file the daemon has open, so the app has to serialise a send.
        expect(SIGNAL_MANIFEST.sendSharesReceiveState).toBe(true);

        const permit: SendPermit = { account: rig.accountId, addresses: [ALICE_ACI] };
        const sender = await rig.backend.openSender(rig.accountId, permit);
        // Signal's body is plain text, and this path sends nothing but a body.
        expect(sender.features.markdown).toBe(false);
        expect(sender.sendImage === undefined).toBe(true);
        await sender.close();

        expect(rig.server.requests.length).toBe(0);
        // The gate is the permit plus this account's own ACI — where the transcript goes.
        expect(rig.server.opened.length).toBe(1);
        expect(rig.server.opened[0].join()).toBe([ALICE_ACI, OWN_ACI].join());
      });
    });

    await it('keeps the receive session unable to reach a send endpoint', async () => {
      await withRig(GRANTED, async (rig) => {
        // The phase gate has no send endpoint at all, whatever the grants say.
        expect(threw(() => checkRequest('sync', req('GET', `/v2/keys/${ALICE_ACI}/*`)))).toBe(true);
        expect(threw(() => checkRequest('sync', req('PUT', `/v1/messages/${ALICE_ACI}`)))).toBe(true);

        // The per-permit gate allows exactly two paths, and only for the ids the permit names.
        const permitted = [ALICE_ACI, OWN_ACI];
        expect(sendRefusal(req('GET', `/v2/keys/${ALICE_ACI}/*`), permitted)).toBe(null);
        expect(sendRefusal(req('GET', `/v2/keys/${ALICE_ACI}/4`), permitted)).toBe(null);
        expect(sendRefusal(req('PUT', `/v1/messages/${ALICE_ACI}?story=false`), permitted)).toBe(null);
        expect(sendRefusal(req('PUT', `/v1/messages/${OWN_ACI}?story=false`), permitted)).toBe(null);

        // Somebody no grant names is refused — without the refusal repeating their ACI.
        for (const request of [
          req('GET', `/v2/keys/${CAROL_ACI}/*`),
          req('PUT', `/v1/messages/${CAROL_ACI}`),
        ]) {
          const reason = sendRefusal(request, permitted);
          expect(reason !== null).toBe(true);
          expect(reason?.includes(CAROL_ACI)).toBe(false);
        }
        // Nothing else becomes reachable with a permit in hand — not even the link endpoints.
        for (const request of [
          req('PUT', '/v1/devices/link'),
          req('PUT', '/v2/keys?identity=aci'),
          req('POST', `/v1/messages/${ALICE_ACI}`),
          req('GET', `/v1/profile/${ALICE_ACI}`),
          req('DELETE', `/v1/messages/${ALICE_ACI}`),
        ]) {
          expect(sendRefusal(request, permitted) !== null).toBe(true);
        }

        // And the receive session itself has no send handle and was handed no send channel.
        const session = await rig.backend.connect(rig.accountId, { mode: 'catch-up' });
        expect('send' in session).toBe(false);
        expect('sendText' in session).toBe(false);
        expect('fetch' in session).toBe(false);
        await session.close();
        expect(rig.server.opened.length).toBe(0);
        expect(rig.server.requests.length).toBe(0);
      });
    });

    await it('refuses without a signal.send grant, before anything is opened', async () => {
      for (const config of [
        { grants: [] },
        // Another backend's send grant for exactly this pair is still not this one.
        { grants: [grant('matrix.send', ALICE_ACI)] },
      ]) {
        await withRig(config, async (rig) => {
          expect(await refused(send(rig, ALICE_ACI, 'Hallo'))).toBe(true);
          expect(rig.server.opened.length).toBe(0);
          expect(rig.server.requests.length).toBe(0);
        });
      }
    });

    await it('refuses an address the grant does not name, a group, a number and a PNI', async () => {
      await withRig(GRANTED, async (rig) => {
        expect(await refused(send(rig, CAROL_ACI, 'Hallo'))).toBe(true);
        expect(rig.server.opened.length).toBe(0);

        const permit: SendPermit = { account: rig.accountId, addresses: [ALICE_ACI] };
        const sender = await rig.backend.openSender(rig.accountId, permit);
        try {
          const refusals = [
            { to: CAROL_ACI, says: 'not granted' },
            // A group needs the member list from the storage service, which curlew does not sync.
            { to: 'group:AAAAAAAAAAAAAAAAAAAAAA==', says: 'cannot send to a Signal group' },
            // A number would have to be resolved through CDSI, and no grant could name it.
            { to: '+4915112345678', says: 'not a Signal account id' },
            { to: `PNI:${ALICE_ACI}`, says: 'not a Signal account id' },
          ];
          for (const { to, says } of refusals) {
            expect((await reasonOf(sender.send({ to, text: 'Hallo' }))).includes(says)).toBe(true);
          }
        } finally {
          await sender.close();
        }
        expect(rig.server.requests.length).toBe(0);
      });
    });

    await it('fans out to every device, syncs the transcript, logs and indexes the message', async () => {
      await withRig(GRANTED, async (rig) => {
        const out = await send(rig, ALICE_ACI, 'Hallo Alice');
        expect(out.backend).toBe('signal');
        expect(out.target).toBe(`${ACCOUNT}/${ALICE_ACI}`);
        expect(out.chatJid).toBe(ALICE_ACI);
        expect(out.sendWarning === undefined).toBe(true);

        // The id is the author plus the sent timestamp — exactly what the transcript comes back as.
        const ts = Number(out.originId.split(':')[1]);
        expect(out.originId).toBe(`${OWN_ACI}:${ts}`);
        expect(Date.parse(out.sentAt)).toBe(ts);

        // The recipient is served BEFORE the own devices: a transcript on the phone for a message
        // the recipient never got would show the user something that does not exist.
        expect(rig.server.requests.map((r) => `${r.verb} ${r.path}`).join(', ')).toBe(
          [
            `GET /v2/keys/${ALICE_ACI}/*`,
            `PUT /v1/messages/${ALICE_ACI}`,
            `GET /v2/keys/${OWN_ACI}/*`,
            `PUT /v1/messages/${OWN_ACI}`,
          ].join(', '),
        );

        // Both of Alice's devices and both OTHER own devices, each under its own registration id —
        // and not curlew itself, which is listed on the server like any other device.
        expect(rig.server.delivered.map((d) => d.to).join()).toBe('alice.1,alice.4,self.1,self.3');
        expect(rig.server.delivered.map((d) => d.registrationId).join()).toBe('101,104,21,103');
        expect(rig.server.delivered.every((d) => d.type === EnvelopeType.PREKEY_MESSAGE)).toBe(true);

        for (const copy of rig.server.delivered.slice(0, 2)) {
          expect(copy.content.dataMessage?.body).toBe('Hallo Alice');
          expect(copy.content.dataMessage?.timestamp).toBe(ts);
          expect(copy.content.syncMessage).toBe(null);
        }
        // The own devices get a transcript, never a message this account sent to itself.
        for (const copy of rig.server.delivered.slice(2)) {
          expect(copy.content.dataMessage).toBe(null);
          const sent = copy.content.syncMessage?.sent;
          expect(sent?.destinationServiceId).toBe(ALICE_ACI);
          expect(sent?.timestamp).toBe(ts);
          expect(sent?.message?.body).toBe('Hallo Alice');
        }

        const lines = readFileSync(join(rig.dir, 'writes.log'), 'utf8').trim().split('\n');
        expect(lines.length).toBe(1);
        const line = JSON.parse(lines[0]);
        expect(line.capability).toBe('signal.send');
        expect(line.target).toBe(`${ACCOUNT}/${ALICE_ACI}`);
        expect(line.id).toBe(out.originId);
        // The write log records that something was sent, never the text of it.
        expect(line.text === undefined).toBe(true);

        const db = openIndex(rig.dbPath);
        try {
          const view = getConversation(db, chatConversationId('signal', ACCOUNT, ALICE_ACI), {
            includeBodies: true,
          });
          expect(view?.messages.length).toBe(1);
          expect(view?.messages[0].fromSelf).toBe(true);
          expect(view?.messages[0].bodyText).toBe('Hallo Alice');
        } finally {
          db.close();
        }

        // A second send proves the lease was given back — and needs no keys, because the sessions
        // from the first one are still good. libsignal keeps sending pre-key messages until the
        // peer answers, so the type does not change here.
        await send(rig, ALICE_ACI, 'Noch etwas');
        expect(rig.server.requests.length).toBe(6);
        expect(rig.server.requests.slice(4).every((r) => r.verb === 'PUT')).toBe(true);
        expect(rig.server.delivered.length).toBe(8);
      });
    });

    await it('refuses a message over the byte limit instead of splitting it', async () => {
      await withRig(GRANTED, async (rig) => {
        // Measured in bytes, not characters: two bytes per 'ä' is one byte over the limit.
        const long = 'ä'.repeat(SIGNAL_MAX_MESSAGE_BYTES / 2 + 1);
        expect((await reasonOf(send(rig, ALICE_ACI, long))).includes('at most')).toBe(true);
        expect(rig.server.requests.length).toBe(0);
      });

      await withRig(GRANTED, async (rig) => {
        await send(rig, ALICE_ACI, 'x'.repeat(SIGNAL_MAX_MESSAGE_BYTES));
        expect(rig.server.delivered.length).toBe(4);
      });
    });

    await it('sends a note to self as the transcript alone', async () => {
      await withRig(GRANTED_SELF, async (rig) => {
        const out = await send(rig, OWN_ACI, 'Notiz an mich');
        expect(out.chatJid).toBe(OWN_ACI);
        expect(rig.server.requests.map((r) => r.verb).join()).toBe('GET,PUT');
        expect(rig.server.requests.every((r) => r.path.includes(OWN_ACI))).toBe(true);
        expect(rig.server.delivered.map((d) => d.to).join()).toBe('self.1,self.3');
        for (const copy of rig.server.delivered) {
          // A `DataMessage` to oneself would come back as a message FROM this device.
          expect(copy.content.dataMessage).toBe(null);
          expect(copy.content.syncMessage?.sent?.destinationServiceId).toBe(OWN_ACI);
          expect(copy.content.syncMessage?.sent?.message?.body).toBe('Notiz an mich');
        }
      });

      // With no other device there is nowhere for the note to live, so it is refused rather than
      // dropped into a 200 that stored nothing.
      await withRig(GRANTED_SELF, async (rig) => {
        rig.own.devices.delete(1);
        rig.own.devices.delete(3);
        expect((await reasonOf(send(rig, OWN_ACI, 'Notiz'))).includes('other devices')).toBe(true);
        expect(rig.server.requests.map((r) => r.verb).join()).toBe('GET');
        expect(rig.server.delivered.length).toBe(0);
      });
    });

    await it('corrects the device list on 409 and 410, and gives up on a server that never agrees', async () => {
      // 409: a device was linked since the last message, so curlew's session list is short one.
      await withRig(GRANTED, async (rig) => {
        await send(rig, ALICE_ACI, 'Erste');
        rig.server.reset();
        rig.alice.add(2, 102);

        await send(rig, ALICE_ACI, 'Zweite');
        // The first PUT is addressed from the known sessions; only the 409 costs a key request.
        expect(rig.server.requests.map((r) => r.verb).join()).toBe('PUT,GET,PUT,PUT');
        expect(rig.server.delivered.map((d) => d.to).join()).toBe('alice.1,alice.2,alice.4,self.1,self.3');
      });

      // 410: the recipient replaced a session, which no client can see coming.
      await withRig(GRANTED, async (rig) => {
        await send(rig, ALICE_ACI, 'Erste');
        rig.server.reset();
        rig.server.stale.set(ALICE_ACI, [1]);

        await send(rig, ALICE_ACI, 'Zweite');
        expect(rig.server.requests.map((r) => r.verb).join()).toBe('PUT,GET,PUT,PUT');
        // The stale session was thrown away and started again; device 4 kept the one it had.
        expect(rig.server.delivered.map((d) => d.to).join()).toBe('alice.1,alice.4,self.1,self.3');
      });

      // A server that answers every attempt with a mismatch is not retried forever.
      await withRig(GRANTED, async (rig) => {
        rig.server.alwaysMismatch = true;
        const reason = await reasonOf(send(rig, ALICE_ACI, 'Hallo'));
        expect(reason.includes('kept disagreeing')).toBe(true);
        // Four PUTs: the first attempt plus three corrections, each after a fresh device list.
        expect(rig.server.requests.filter((r) => r.verb === 'PUT').length).toBe(4);
        expect(rig.server.requests.filter((r) => r.verb === 'GET').length).toBe(4);
        expect(rig.server.delivered.length).toBe(0);
      });
    });

    await it('refuses a changed safety number, and sends once it is accepted', async () => {
      await withRig(GRANTED, async (rig) => {
        await send(rig, ALICE_ACI, 'Erste');
        rig.server.reset();

        // Alice reinstalled: a new identity key, one device, and the old sessions are stale.
        rig.server.add(new Contact(ALICE_ACI)).add(1, 101);
        rig.server.stale.set(ALICE_ACI, [1, 4]);
        const reason = await reasonOf(send(rig, ALICE_ACI, 'Zweite'));
        expect(reason.includes('safety number')).toBe(true);
        expect(reason.includes(ALICE_ACI)).toBe(true);
        expect(rig.server.delivered.length).toBe(0);

        // The new key was stored before the refusal, so sending again IS the acknowledgement.
        rig.server.reset();
        await send(rig, ALICE_ACI, 'Zweite');
        expect(rig.server.delivered.map((d) => d.to).join()).toBe('alice.1,self.1,self.3');
      });
    });

    await it('reports the missing transcript as a warning, not as a failed send', async () => {
      await withRig(GRANTED, async (rig) => {
        rig.server.putStatus.set(OWN_ACI, 500);
        const out = await send(rig, ALICE_ACI, 'Hallo Alice');
        // The recipient has it. Failing the call would get it sent twice on the retry, so the
        // delivery stands and the gap is named in the answer.
        expect(out.sendWarning?.includes('will not appear on the phone')).toBe(true);
        expect(rig.server.delivered.map((d) => d.to).join()).toBe('alice.1,alice.4');
        expect(rig.server.requests.filter((r) => r.verb === 'PUT').length).toBe(2);
      });
    });

    await it('replaces the local echo when the transcript comes back from another device', async () => {
      await withRig(GRANTED, async (rig) => {
        const out = await send(rig, ALICE_ACI, 'Hallo Alice');
        expect(out.messageId !== null).toBe(true);
        const ts = Number(out.originId.split(':')[1]);

        // Signal does not echo a transcript back to the device that sent it, so this is the phone
        // relaying it — a linked device sending the same message is the case this guards.
        rig.inbox.push(
          await directEnvelope(
            rig.phone.device,
            {
              sent: {
                destinationServiceId: ALICE_ACI,
                timestamp: ts,
                message: { body: 'Hallo Alice', timestamp: ts },
              },
            },
            ts,
          ),
        );
        const db = openIndex(rig.dbPath);
        try {
          const result = await receiveDeliveries(db, rig.backend);
          expect(result.errors).toBe(0);
          rebuildConversations(db);
          const view = getConversation(db, chatConversationId('signal', ACCOUNT, ALICE_ACI), {
            includeBodies: true,
          });
          // One message, not the echo plus the received copy.
          expect(view?.messages.length).toBe(1);
          expect(view?.messages[0].ref.remoteId).toBe(out.originId);
          expect(view?.messages[0].fromSelf).toBe(true);
          expect(view?.messages[0].bodyText).toBe('Hallo Alice');
        } finally {
          db.close();
        }
      });
    });

    await it('refuses to send while the daemon is receiving this account', async () => {
      await withRig(GRANTED, async (rig) => {
        // The ratchet lives in one file with no lock, and a broken session is not fixed by
        // retrying — so a send next to a receive is refused rather than risked.
        const db = openIndex(rig.dbPath);
        try {
          takeReceiveLease(db, 'signal', ACCOUNT, 'daemon-4242', new Date());
        } finally {
          db.close();
        }

        const reason = await reasonOf(send(rig, ALICE_ACI, 'Hallo'));
        expect(reason.includes('daemon-4242')).toBe(true);
        expect(reason.includes('curlew daemon stop')).toBe(true);
        // Refused before the handle exists, so it costs no connection and no ratchet step.
        expect(rig.server.opened.length).toBe(0);
        expect(rig.server.requests.length).toBe(0);
      });
    });

    await it('sends on the session the daemon is receiving on, through the same gate', async () => {
      await withRig(GRANTED, async (rig) => {
        // Decrypted on this store before the send, so the send below ratchets on state the
        // receiver has moved — the case the fence in `receiver.exclusive` exists for.
        const ts = 1_767_300_000_000;
        await introduceTo(rig, rig.phone.device);
        rig.inbox.push(
          await directEnvelope(
            rig.phone.device,
            {
              sent: {
                destinationServiceId: CAROL_ACI,
                timestamp: ts,
                message: { body: 'vorher', timestamp: ts },
              },
            },
            ts,
          ),
        );
        const session = await rig.backend.connect(rig.accountId, { mode: 'follow' });
        expect(((await session.nextBatch()) ?? []).length > 0).toBe(true);

        const sender = await session.openSender!({ account: rig.accountId, addresses: [ALICE_ACI] });
        // The same gate as a connection of its own: the permit plus this account's own ACI.
        expect(rig.server.opened.length).toBe(1);
        expect(rig.server.opened[0].join()).toBe([ALICE_ACI, OWN_ACI].join());

        const sent = await sender.send({ to: ALICE_ACI, text: 'Hallo Alice' });
        expect(sent.target).toBe(ALICE_ACI);
        // The same fan-out, because it is the same sender on the same store — every device of
        // Alice's and of this account's own, minus curlew itself.
        expect(rig.server.delivered.map((d) => d.to).join()).toBe('alice.1,alice.4,self.1,self.3');

        // The sender closed its send channel and nothing else: the connection, the journal and
        // the session file belong to the receiver and outlive every sender.
        await sender.close();
        expect(rig.server.opened.length).toBe(1);
        expect(session.outcome().error).toBe(null);
        const pending = session.nextBatch();
        await session.close();
        expect(await pending).toBe(null);
      });
    });

    await it('rewinds a ratchet step the server did not take, on the shared store', async () => {
      await withRig(GRANTED, async (rig) => {
        const session = await rig.backend.connect(rig.accountId, { mode: 'follow' });
        const sender = await session.openSender!({ account: rig.accountId, addresses: [ALICE_ACI] });
        const keysOfAlice = () =>
          rig.server.requests.filter((r) => r.verb === 'GET' && r.path === `/v2/keys/${ALICE_ACI}/*`).length;

        // The server does not take the first attempt. The ratchet step it cost must not stay on
        // the store the receiver decrypts with: `discard()` clears the dirty marks but keeps the
        // advanced session in memory, so the store is rewound from the file instead.
        rig.server.putStatus.set(ALICE_ACI, 500);
        expect(await reasonOf(sender.send({ to: ALICE_ACI, text: 'Hallo Alice' }))).toMatch(
          /refused the message.*nothing was sent/,
        );
        expect(rig.server.delivered.length).toBe(0);

        // Rewound: the session that attempt established is gone with it, so the retry asks for
        // Alice's pre-keys again instead of ratcheting on from a step she never saw.
        rig.server.reset();
        await sender.send({ to: ALICE_ACI, text: 'Hallo Alice' });
        expect(keysOfAlice()).toBe(1);
        expect(rig.server.delivered.map((d) => d.to).join()).toBe('alice.1,alice.4,self.1,self.3');

        // And a send the server DID take flushed its state, so it survives the fence: the next
        // one reuses the session and fetches nothing. Which is what makes the fetch above a
        // measurement of the rewind rather than of a path that always re-fetches.
        rig.server.reset();
        await sender.send({ to: ALICE_ACI, text: 'Noch eine' });
        expect(keysOfAlice()).toBe(0);
        expect(rig.server.delivered.map((d) => d.to).join()).toBe('alice.1,alice.4,self.1,self.3');

        await sender.close();
        await session.close();
      });
    });

    await it('serves send_message to the MCP gate with a signal.send grant alone', async () => {
      const target = `${ACCOUNT}/${ALICE_ACI}`;
      const union = withSendGateGrants([{ capability: 'signal.send', target }]);
      const sendGrants = union.filter((g) => g.capability === 'send');
      expect(sendGrants.length).toBe(1);
      expect(sendGrants[0].target).toBe(target);
      // Nothing else that writes: the grant that serves `send_message` serves only that.
      expect(union.every((g) => g.capability === 'send' || g.capability === 'signal.send')).toBe(true);
    });
  });
};
