/**
 * Turning one `<encrypted>` element back into text (ADR 0006 §8).
 *
 * The whole ratchet step — load the session, advance it, record what the key exchange consumed —
 * happens inside ONE storage transaction, because `curlew sync` and the daemon are separate
 * processes on one account file (§4). Two of them that each load, step and save a session fork
 * the ratchet, and a forked ratchet loses messages with no error anywhere.
 *
 * The caller's index write belongs inside that transaction too, which is what {@link
 * ReceiveOptions.commit} is for: decrypt → write the row → commit the step. A crash between the
 * two leaves the session unadvanced, so the next catch-up decrypts the message again and the
 * archive id deduplicates it. The other order loses it.
 *
 * Nothing here decides trust beyond BTBV (`omemo-trust.ts`) and nothing here sends: a failure is
 * a reason, never an automatic new session — XEP-0384 §6 is explicit that answering a decryption
 * error with a fresh key exchange is how two clients ratchet past each other forever.
 */

import {
  bytesToUtf8,
  decodeKeyExchange,
  decryptPayload,
  fromBase64,
  isAuthenticationFailedError,
  isDecryptionFailedError,
  isDuplicateMessageError,
  keyPairFromPrivate,
  LEGACY_PROFILE,
  Session,
  type DeviceAddress,
  type DeviceId,
  type OmemoProfile,
  type OmemoStorage,
  type PreKeyPair,
  type RandomSource,
  type SignedPreKeyPair,
  type TrustState,
} from '@curlew/omemo';
import type { EncryptedKey, EncryptedStanza } from './omemo-stanza.ts';
import type { OwnDevice } from './omemo-device.ts';
import { noteIdentity, type IdentityOutcome } from './omemo-trust.ts';

/**
 * Why a message stayed unreadable.
 *
 * `not-for-this-device` is the permanent one — the sender addressed devices that did not include
 * ours, which is what every message from before curlew announced itself looks like. The others
 * may resolve: `no-session` once the peer sends a key exchange, `v2` once curlew speaks OMEMO 2.
 *
 * `duplicate` is not an error and is not indexed: the ratchet recognised a message it has
 * already decrypted (XEP-0384 §6 asks for it to be dropped), which happens whenever a carbon and
 * the archive copy of one message both reach us.
 */
export type UndecryptableReason =
  | 'not-for-this-device'
  | 'no-session'
  | 'bad-mac'
  | 'v2'
  | 'malformed'
  | 'duplicate';

/** A message the ratchet opened. */
export interface DecryptedMessage {
  readonly kind: 'decrypted';
  /** The body, or null for a keys-only message — a session set-up that says nothing. */
  readonly text: string | null;
  /** Which device of the sender wrote it. */
  readonly senderDeviceId: DeviceId;
  /** How much that device's identity key is trusted, as stored with the message (§6). */
  readonly trust: TrustState;
  /** Whether this device's key was new or had changed — a changed one is never silent (§6). */
  readonly identity: IdentityOutcome;
}

/** A message that stayed closed, with the reason to index beside it. */
export interface UndecryptableMessage {
  readonly kind: 'undecryptable';
  readonly reason: UndecryptableReason;
  /** The sending device, where the stanza named one at all. */
  readonly senderDeviceId?: DeviceId;
}

export type ReceiveOutcome = DecryptedMessage | UndecryptableMessage;

export interface ReceiveOptions {
  readonly profile?: OmemoProfile;
  readonly random?: RandomSource;
  readonly now?: () => Date;
  /**
   * Keep a consumed prekey until the catch-up ends, instead of deleting it at once.
   *
   * True while reading an archive (ADR 0006 §3): one prekey may appear in several archived key
   * exchanges, and deleting it on the first would make every later one `no-session`.
   * `deleteConsumedPreKeys` finishes the job when the page loop has run out.
   */
  readonly deferPreKeyDeletion?: boolean;
  /**
   * Run with the decrypted outcome before the ratchet step commits — the caller's index write.
   *
   * A throw here rolls the step back, which is the point: the message is then decrypted again on
   * the next pass rather than lost to a session that moved on without it.
   */
  readonly commit?: (outcome: DecryptedMessage) => Promise<void>;
}

/**
 * Decrypt what one `<encrypted>` element holds for this device.
 *
 * `senderJid` is the BARE JID of whoever sent it — sessions are keyed by account and device, not
 * by resource, and a peer that reconnects from another client is the same device.
 */
export async function receiveOmemo(
  storage: OmemoStorage,
  device: OwnDevice,
  senderJid: string,
  stanza: EncryptedStanza,
  options: ReceiveOptions = {},
): Promise<ReceiveOutcome> {
  const ours = stanza.keys.find((key) => key.deviceId === device.deviceId);
  if (ours === undefined) {
    return { kind: 'undecryptable', reason: 'not-for-this-device', senderDeviceId: stanza.senderDeviceId };
  }

  const address: DeviceAddress = { jid: senderJid, deviceId: stanza.senderDeviceId };
  const profile = options.profile ?? LEGACY_PROFILE;
  const now = options.now ?? (() => new Date());

  return storage.transaction(async () => {
    let outcome: DecryptedMessage;
    try {
      const opened = await openKeyMaterial(storage, device, address, ours, options);
      if (opened.kind === 'undecryptable') return opened;

      const text =
        stanza.payload === undefined
          ? null
          : bytesToUtf8(await decryptPayload(stanza.payload, stanza.iv, opened.keyMaterial, profile));
      const noted = await noteIdentity(storage, address, opened.theirIdentityKey, now());
      outcome = {
        kind: 'decrypted',
        text,
        senderDeviceId: stanza.senderDeviceId,
        trust: noted.record.trust,
        identity: noted.outcome,
      };
    } catch (err) {
      return { kind: 'undecryptable', reason: reasonFor(err), senderDeviceId: stanza.senderDeviceId };
    }
    // Outside the catch on purpose: a failing index write is the caller's problem to hear about,
    // and it must roll the ratchet step back rather than be filed as an unreadable message.
    await options.commit?.(outcome);
    return outcome;
  });
}

/** What the ratchet yielded, or why it could not run. */
type Opened =
  | { kind: 'opened'; keyMaterial: Uint8Array; theirIdentityKey: Uint8Array }
  | UndecryptableMessage;

/**
 * Advance the session this `<key>` belongs to and save it.
 *
 * A key exchange on an EXISTING session is the normal case rather than a conflict: the peer keeps
 * wrapping every message until one of ours answers, so re-running the agreement would throw away
 * a live ratchet for each of them. `Session.decryptKeyExchange` reads the message inside and
 * leaves the session alone.
 */
async function openKeyMaterial(
  storage: OmemoStorage,
  device: OwnDevice,
  address: DeviceAddress,
  key: EncryptedKey,
  options: ReceiveOptions,
): Promise<Opened> {
  const profile = options.profile ?? LEGACY_PROFILE;
  const sessionOptions = {
    profile,
    ...(options.random === undefined ? {} : { random: options.random }),
  };
  const stored = await storage.loadSession(address);

  if (stored !== undefined) {
    const session = Session.fromRecord(stored, sessionOptions);
    const keyMaterial = key.keyExchange
      ? await session.decryptKeyExchange(key.bytes)
      : await session.decrypt(key.bytes);
    await storage.saveSession(address, session.toRecord());
    return { kind: 'opened', keyMaterial, theirIdentityKey: fromBase64(stored.theirIdentityKey) };
  }

  if (!key.keyExchange) {
    // A bare message with no session: the peer ratcheted on without us (our prekey is long spent,
    // or the file was restored from a backup). Starting a session here would not help — it is
    // their ratchet that holds the keys — so the message is simply unreadable.
    return { kind: 'undecryptable', reason: 'no-session', senderDeviceId: address.deviceId };
  }

  const exchange = decodeKeyExchange(key.bytes, profile);
  const keys = await resolveExchangeKeys(storage, device, exchange.signedPreKeyId, exchange.preKeyId);
  if (keys === undefined) {
    // The exchange names keys we no longer hold: a signed prekey rotated out from under it, or a
    // prekey already spent and deleted. Both are `no-session` and both are permanent.
    return { kind: 'undecryptable', reason: 'no-session', senderDeviceId: address.deviceId };
  }

  const { session, keyMaterial } = await Session.accept(
    { identityKey: device.identityKey, signedPreKey: keys.signedPreKey, preKey: keys.preKey },
    exchange,
    sessionOptions,
  );
  await storage.saveSession(address, session.toRecord());
  // Only now: the prekey is spent exactly when the message it unlocked proved the sender holds
  // what the exchange claimed. `Session.accept` returning both is what makes that possible.
  if (options.deferPreKeyDeletion === true) {
    await storage.markPreKeyConsumed(keys.preKey.id, (options.now ?? (() => new Date()))().toISOString());
  } else {
    await storage.deletePreKey(keys.preKey.id);
  }
  return { kind: 'opened', keyMaterial, theirIdentityKey: exchange.identityKey };
}

/** Our halves of the two keys a received exchange names, or undefined when one is gone. */
async function resolveExchangeKeys(
  storage: OmemoStorage,
  device: OwnDevice,
  signedPreKeyId: number,
  preKeyId: number,
): Promise<{ signedPreKey: SignedPreKeyPair; preKey: PreKeyPair } | undefined> {
  const signed = await storage.loadSignedPreKey(signedPreKeyId);
  const preKey = await storage.loadPreKey(preKeyId);
  if (signed === undefined || preKey === undefined) return undefined;
  try {
    return {
      signedPreKey: {
        id: signed.id,
        ...keyPairFromPrivate(fromBase64(signed.privateKey)),
        signature: fromBase64(signed.signature),
      },
      preKey: { id: preKey.id, ...keyPairFromPrivate(fromBase64(preKey.privateKey)) },
    };
  } catch {
    return undefined;
  }
}

/**
 * The reason to index for a thrown error.
 *
 * Anything that is not recognisably a MAC failure or a duplicate is `malformed` rather than an
 * exception reaching the sync loop: one unreadable message in an archive must not stop the
 * account's catch-up, and the archive is full of other clients' bugs.
 */
function reasonFor(err: unknown): UndecryptableReason {
  if (isDuplicateMessageError(err)) return 'duplicate';
  // The payload's AES-GCM tag and the ratchet's HMAC are both "this did not authenticate", and a
  // reader has nothing to do differently for either: both say the bytes are not what was sent.
  if (isAuthenticationFailedError(err) || isDecryptionFailedError(err)) return 'bad-mac';
  return 'malformed';
}
