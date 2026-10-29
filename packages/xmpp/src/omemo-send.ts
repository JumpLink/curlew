/**
 * Encrypting one outgoing 1:1 message (ADR 0006 §7).
 *
 * Two steps, deliberately apart. {@link planOmemoSend} asks the network who the recipients are —
 * every device of the peer and every OTHER device of our own account, so the message is readable
 * where the person reads their chats — and decides whether sending at all is allowed. It runs
 * OUTSIDE any transaction, because it is round trips. {@link encryptOmemo} then takes that plan,
 * opens one storage transaction, and advances a ratchet per recipient device.
 *
 * The rule the whole module exists to keep: **a peer who has OMEMO devices is never sent
 * plaintext.** A fetch that failed, a bundle that would not parse, a key that changed under an
 * existing device id — none of them fall back to the clear. They throw
 * {@link OmemoSendRefusedError}, which the caller reports to the person, because a message the
 * person believed was encrypted and was not is worse than a message that did not go.
 *
 * The transaction commits BEFORE the stanza reaches the socket. That costs one message key per
 * recipient when the send then fails — the ratchet moved for a message nobody received, and the
 * peer's client skips it — which is a case the protocol handles. Holding the account file's
 * `BEGIN IMMEDIATE` lock across a network write is not: `curlew sync` and the daemon are
 * separate processes on one file (§4), and a stalled socket would block the other one for as
 * long as the stall lasts.
 */

import {
  encryptPayload,
  LEGACY_PROFILE,
  mayEncryptTo,
  randomBytes,
  selectBundleKeys,
  Session,
  utf8ToBytes,
  type BundleKeys,
  type DeviceAddress,
  type DeviceId,
  type OmemoProfile,
  type OmemoStorage,
  type RandomSource,
  type TrustState,
} from '@curlew/omemo';
import type { OwnDevice } from './omemo-device.ts';
import { fetchBundle, fetchDeviceList, type PepPort } from './omemo-publish.ts';
import type { EncryptedKey, EncryptedStanza } from './omemo-stanza.ts';
import { noteBundleIdentity } from './omemo-trust.ts';

/**
 * Why a message was not sent.
 *
 * Each one is a different thing to tell the person, which is why they are not one string:
 * `device-list-failed` is "try again", `no-trusted-device` is "decide about their key", and
 * `no-usable-bundle` is "their client has to come online".
 */
export type RefusalReason =
  /** The peer's device list could not be read and no cached one existed. */
  | 'device-list-failed'
  /** The peer has devices, but none this account may encrypt to (§6). */
  | 'no-trusted-device'
  /** Every device of the peer is unreachable: no bundle published, or none that parsed. */
  | 'no-usable-bundle';

/** A device left out of a send, with why. */
export interface SkippedDevice {
  readonly address: DeviceAddress;
  readonly reason: SkipReason;
}

/**
 * Why one device got no copy.
 *
 * Skipping a device is not refusing to send: the others still get the message, and this is the
 * ordinary state of a contact who has an old phone in their device list. Refusal happens only
 * when nothing of the PEER's is left — see {@link planOmemoSend}.
 */
export type SkipReason =
  /** A person marked this device distrusted, or has verified another and not yet this one. */
  | 'untrusted'
  /** No session, and the device published no usable bundle to build one from. */
  | 'no-bundle'
  /** No session, and the bundle could not be fetched — a server error, not an empty node. */
  | 'bundle-failed'
  /** The device's published key is not the key we hold for it (`noteBundleIdentity`). */
  | 'identity-changed';

/** A send that did not happen, with the reason to show and the devices that were skipped. */
export class OmemoSendRefusedError extends Error {
  readonly name = 'OmemoSendRefusedError';
  readonly reason: RefusalReason;
  /** What was learned about the peer's devices on the way. Never includes the message. */
  readonly skipped: readonly SkippedDevice[];

  constructor(reason: RefusalReason, skipped: readonly SkippedDevice[] = []) {
    super(`OMEMO send refused: ${reason}`);
    this.reason = reason;
    this.skipped = skipped;
  }
}

/**
 * Narrow a thrown value to {@link OmemoSendRefusedError}.
 *
 * By name, like `@curlew/omemo`'s helpers: the error crosses a package boundary and a second
 * copy of the class would make `instanceof` answer false for an error that is one.
 */
export function isOmemoSendRefusedError(err: unknown): err is OmemoSendRefusedError {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'OmemoSendRefusedError'
  );
}

/** One device the message will be encrypted for, with what it takes to reach it. */
export interface Recipient {
  readonly address: DeviceAddress;
  /**
   * The keys to start a session from, when there is no session yet.
   *
   * Undefined means a session already exists in storage and the ratchet continues. It is not
   * resolved here into a `Session`, because building one must happen inside the transaction —
   * between the plan and the encrypt, another process may have created that session.
   */
  readonly bundle?: BundleKeys;
}

/** What {@link planOmemoSend} decided. */
export interface OmemoSendPlan {
  readonly recipients: readonly Recipient[];
  /** Devices left out, for the caller to log by category. */
  readonly skipped: readonly SkippedDevice[];
  /**
   * The peer's device list came from an expired cache the server would not refresh.
   *
   * The message still goes — a list we hold is better than plaintext — but a device the peer
   * added since is not in it, and that copy will be unreadable there.
   */
  readonly staleDeviceList: boolean;
}

export interface PlanOptions {
  readonly random?: RandomSource;
  readonly now?: () => Date;
  readonly ttlMs?: number;
}

/**
 * Who this message has to be encrypted for, or a refusal.
 *
 * `peerJid` and `selfJid` are BARE: device lists, sessions and trust are per account, never per
 * resource. Our own other devices are addressed too (XEP-0384 §4.5) — without them the message
 * is unreadable on the person's own phone — but our OWN device is not, since it cannot ratchet
 * with itself.
 *
 * Returns null when the peer has no OMEMO at all. That is the one case where plaintext is
 * correct, and it is the caller's to act on.
 */
export async function planOmemoSend(
  pep: PepPort,
  storage: OmemoStorage,
  device: OwnDevice,
  selfJid: string,
  peerJid: string,
  options: PlanOptions = {},
): Promise<OmemoSendPlan | null> {
  const ttl = options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs };
  const now = options.now ?? (() => new Date());
  const peers = await fetchDeviceList(pep, storage, peerJid, { now, ...ttl });
  if (peers.kind === 'failed') throw new OmemoSendRefusedError('device-list-failed');
  if (peers.deviceIds.length === 0) return null;

  // Our own list is allowed to fail: it costs the person a copy on their other devices, which is
  // a worse message than no message at all only if there is no message at all. The PEER is what
  // the refusal rule protects.
  const own = await fetchDeviceList(pep, storage, selfJid, { now, ...ttl });
  const ownIds = own.kind === 'failed' ? [] : own.deviceIds.filter((id) => id !== device.deviceId);

  const skipped: SkippedDevice[] = [];
  const recipients: Recipient[] = [];
  let peerRecipients = 0;
  for (const jid of [peerJid, selfJid]) {
    for (const deviceId of jid === peerJid ? peers.deviceIds : ownIds) {
      const resolved = await resolveRecipient(pep, storage, { jid, deviceId }, options);
      if (resolved.kind === 'skip') {
        skipped.push({ address: { jid, deviceId }, reason: resolved.reason });
        continue;
      }
      recipients.push(resolved.recipient);
      if (jid === peerJid) peerRecipients++;
    }
  }

  // Only the peer's devices decide this. A send that reached the peer but none of our own other
  // devices is a send; a send that reached none of the peer's is not, whatever we told the user.
  if (peerRecipients === 0) throw new OmemoSendRefusedError(refusalFor(skipped, peerJid), skipped);
  return { recipients, skipped, staleDeviceList: peers.stale };
}

/** Which of the peer's skips explains the refusal: the one that says the most about why. */
function refusalFor(skipped: readonly SkippedDevice[], peerJid: string): RefusalReason {
  const reasons = new Set(skipped.filter((s) => s.address.jid === peerJid).map((s) => s.reason));
  // A changed key is a trust decision the person has to make, like a distrusted one.
  if (reasons.has('untrusted') || reasons.has('identity-changed')) return 'no-trusted-device';
  return 'no-usable-bundle';
}

type Resolved = { kind: 'recipient'; recipient: Recipient } | { kind: 'skip'; reason: SkipReason };

/**
 * Decide about one device: continue its session, start one from its bundle, or skip it.
 *
 * A device with a stored session is NOT asked for its bundle — the ratchet needs nothing from
 * the server, and fetching anyway would spend one of the peer's prekeys on every message.
 */
async function resolveRecipient(
  pep: PepPort,
  storage: OmemoStorage,
  address: DeviceAddress,
  options: PlanOptions,
): Promise<Resolved> {
  const identity = await storage.loadIdentity(address);
  if (identity !== undefined && !mayEncryptTo(identity.trust)) return { kind: 'skip', reason: 'untrusted' };
  if ((await storage.loadSession(address)) !== undefined) return { kind: 'recipient', recipient: { address } };

  const lookup = await fetchBundle(pep, address.jid, address.deviceId);
  if (lookup.kind === 'failed') return { kind: 'skip', reason: 'bundle-failed' };
  if (lookup.kind === 'none') return { kind: 'skip', reason: 'no-bundle' };

  // BTBV on a key off a bundle: adopted when the device is new to us, refused when it replaces
  // one we hold. `noteBundleIdentity` writes at most one record and is run again inside the
  // transaction, where the record it reports is the one the session is built against.
  const noted = await noteBundleIdentity(
    storage,
    address,
    lookup.bundle.identityKey,
    (options.now ?? (() => new Date()))(),
  );
  if (noted.outcome === 'replaced') return { kind: 'skip', reason: 'identity-changed' };
  if (!mayEncryptTo(noted.record.trust)) return { kind: 'skip', reason: 'untrusted' };

  try {
    return {
      kind: 'recipient',
      recipient: { address, bundle: selectBundleKeys(lookup.bundle, options.random) },
    };
  } catch {
    // `selectBundleKeys` asserts the bundle again and throws on an empty prekey list — a peer
    // whose prekeys are all spent and who has not been online to refill them.
    return { kind: 'skip', reason: 'no-bundle' };
  }
}

export interface EncryptOptions {
  readonly profile?: OmemoProfile;
  readonly random?: RandomSource;
  readonly now?: () => Date;
}

/**
 * Encrypt one message for the planned recipients, advancing every ratchet in ONE transaction.
 *
 * `text` null is an empty OMEMO message (XEP-0384 §4.6): key material still goes through every
 * ratchet, so sessions are established and repaired, but there is no `<payload>` and nothing to
 * show. Random key material rather than a fixed filler, so the bytes on the wire tell an
 * observer nothing about whether a message carried content.
 *
 * The result is the same shape `parseEncryptedElement` produces, which is what makes it testable
 * against the receive path without any XML in between.
 */
export async function encryptOmemo(
  storage: OmemoStorage,
  device: OwnDevice,
  plan: OmemoSendPlan,
  text: string | null,
  options: EncryptOptions = {},
): Promise<EncryptedStanza> {
  const profile = options.profile ?? LEGACY_PROFILE;
  const random = options.random;
  const now = options.now ?? (() => new Date());
  const sessionOptions = { profile, ...(random === undefined ? {} : { random }) };

  const payload =
    text === null
      ? undefined
      : await encryptPayload(utf8ToBytes(text), random, profile);
  // An empty message still needs key material of the right length to put through the ratchets,
  // and an IV, because `parseEncryptedElement` rejects an element without one.
  const keyMaterial =
    payload?.keyMaterial ??
    randomBytes(profile.payloadKeyLength + profile.payloadTagLength, random);
  const iv = payload?.iv ?? randomBytes(profile.payloadIvLength, random);

  const keys = await storage.transaction(async () => {
    const out: EncryptedKey[] = [];
    for (const recipient of plan.recipients) {
      const session = await loadOrInitiate(storage, device, recipient, sessionOptions, now);
      if (session === undefined) continue;
      const message = await session.encrypt(keyMaterial);
      await storage.saveSession(recipient.address, session.toRecord());
      out.push({
        deviceId: recipient.address.deviceId,
        keyExchange: message.kind === 'key-exchange',
        bytes: message.bytes,
      });
    }
    return out;
  });

  if (keys.length === 0) throw new OmemoSendRefusedError('no-usable-bundle', plan.skipped);
  return {
    senderDeviceId: device.deviceId,
    keys,
    iv,
    ...(payload === undefined ? {} : { payload: payload.ciphertext }),
  };
}

/**
 * The session to encrypt with: the stored one, or a new one from the planned bundle.
 *
 * The stored session is re-read HERE, inside the transaction, and wins over the plan's bundle.
 * Between planning and encrypting, the other process on this account file may have accepted a
 * key exchange from that very device; replacing that session with one built from a bundle would
 * throw away a live ratchet, and the peer would be left holding a session we no longer have.
 *
 * Undefined means the device has to be dropped after all — it had neither.
 */
async function loadOrInitiate(
  storage: OmemoStorage,
  device: OwnDevice,
  recipient: Recipient,
  options: { profile: OmemoProfile; random?: RandomSource },
  now: () => Date,
): Promise<Session | undefined> {
  const stored = await storage.loadSession(recipient.address);
  if (stored !== undefined) return Session.fromRecord(stored, options);
  if (recipient.bundle === undefined) return undefined;

  const noted = await noteBundleIdentity(storage, recipient.address, recipient.bundle.identityKey, now());
  if (noted.outcome === 'replaced' || !mayEncryptTo(noted.record.trust)) return undefined;
  return Session.initiate(device.identityKey, recipient.bundle, options);
}

/** How a planned recipient's trust stands, for the caller to report without re-reading storage. */
export interface RecipientTrust {
  readonly address: DeviceAddress;
  readonly trust: TrustState;
  /** Whether the first message to this device still carries a key exchange. */
  readonly pendingKeyExchange: boolean;
}

/**
 * What the plan's recipients look like in storage — trust and whether a key exchange is pending.
 *
 * For reporting only; nothing here decides anything. `pendingKeyExchange` is what tells a caller
 * that a device has not answered yet, which is the one thing a heartbeat could repair. There is
 * no time threshold to go with it: a `SessionRecord` carries no timestamp, so "pending since
 * when" is not a question this storage can answer.
 */
export async function recipientTrust(
  storage: OmemoStorage,
  plan: OmemoSendPlan,
): Promise<RecipientTrust[]> {
  const out: RecipientTrust[] = [];
  for (const recipient of plan.recipients) {
    const identity = await storage.loadIdentity(recipient.address);
    const session = await storage.loadSession(recipient.address);
    out.push({
      address: recipient.address,
      trust: identity?.trust ?? 'undecided',
      pendingKeyExchange: session?.pendingKeyExchange !== undefined,
    });
  }
  return out;
}

/**
 * Plan and encrypt in one go — what a send path that has no use for the plan calls.
 *
 * Null through, unchanged: no OMEMO devices on the other side means plaintext is what the peer
 * can read, and saying so is this function's whole answer. Anything else throws.
 */
export async function omemoEncryptFor(
  pep: PepPort,
  storage: OmemoStorage,
  device: OwnDevice,
  selfJid: string,
  peerJid: string,
  text: string | null,
  options: PlanOptions & EncryptOptions = {},
): Promise<EncryptedStanza | null> {
  const plan = await planOmemoSend(pep, storage, device, selfJid, peerJid, options);
  if (plan === null) return null;
  return encryptOmemo(storage, device, plan, text, options);
}
