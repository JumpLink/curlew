/**
 * A session with one device: the key agreement, the ratchet, and the bookkeeping around them.
 *
 * This is the layer the rest of curlew will talk to. It owns three things the ratchet
 * deliberately does not:
 *
 *  - **The direction of the associated data.** The ratchet authenticates whatever bytes it is
 *    handed; which two identity keys those are, and in which order, depends on who is sending.
 *    Both identity public keys live here and {@link Session.encrypt} / {@link Session.decrypt}
 *    pick the order. See {@link associatedData} for why the order is per-message.
 *  - **The pending key exchange.** The initiator cannot know its bundle fetch produced a session
 *    the peer ever processed, so every message stays wrapped in an `OMEMOKeyExchange` until a
 *    message comes back. Conversations does the same; dropping the wrapper early loses the
 *    conversation's first messages if the peer was offline.
 *  - **Serialization.** A session is loaded, stepped once and saved again inside one transaction
 *    (ADR 0006 §4), so it has to survive a round trip through JSON exactly.
 *
 * What is NOT here: trust, device lists, prekey replenishment, stanza building. Those are stage
 * 2, and keeping them out is what makes this testable against recorded fixtures.
 */

import { fromBase64, toBase64 } from './bytes.ts';
import { defaultRandomSource, type RandomSource } from './crypto.ts';
import { KeyExchangeFailedError } from './errors.ts';
import {
  associatedData,
  type KeyPair,
  type PreKeyPair,
  type SignedPreKeyPair,
} from './keys.ts';
import { LEGACY_PROFILE, type OmemoProfile } from './profile.ts';
import { Ratchet, type RatchetOptions, type RatchetStateRecord, type SkippedKeyLimits } from './ratchet.ts';
import { x3dhActive, x3dhPassive, type BundleKeys } from './x3dh.ts';
import {
  decodeKeyExchange,
  encodeKeyExchange,
  splitAuthenticatedMessage,
  type OmemoKeyExchange,
} from './wire.ts';

/** What kind of blob an outgoing message is, which the stanza layer turns into `prekey="true"`. */
export type OutgoingKind = 'key-exchange' | 'message';

/** One encrypted blob for one device. */
export interface OutgoingMessage {
  /** Whether this is a bare message or a message wrapped in a key exchange. */
  readonly kind: OutgoingKind;
  /** The serialized bytes, ready to be base64-encoded into a `<key>` element. */
  readonly bytes: Uint8Array;
}

/** The key exchange the initiator keeps resending until the peer answers. */
interface PendingKeyExchange {
  readonly preKeyId: number;
  readonly signedPreKeyId: number;
  readonly ephemeralKey: Uint8Array;
  readonly identityKey: Uint8Array;
}

/** {@link PendingKeyExchange}, base64-encoded for storage. */
export interface PendingKeyExchangeRecord {
  /** Which of the peer's prekeys this exchange consumed. */
  readonly preKeyId: number;
  /** Which of the peer's signed prekeys it used. */
  readonly signedPreKeyId: number;
  /** Our ephemeral public key, base64. */
  readonly ephemeralKey: string;
  /** Our identity public key, base64. */
  readonly identityKey: string;
}

/** A whole session, JSON-serializable. See {@link Session.toRecord}. */
export interface SessionRecord {
  /** Which OMEMO profile the session speaks. */
  readonly version: string;
  /** Our identity public key, base64. */
  readonly ourIdentityKey: string;
  /** The peer device's identity public key, base64. */
  readonly theirIdentityKey: string;
  /** The ratchet's state. */
  readonly ratchet: RatchetStateRecord;
  /** The key exchange still being prefixed to outgoing messages, if any. */
  readonly pendingKeyExchange?: PendingKeyExchangeRecord | undefined;
}

/** Construction-time knobs for a session. */
export interface SessionOptions {
  /** Which OMEMO profile to speak. Defaults to {@link LEGACY_PROFILE}. */
  readonly profile?: OmemoProfile;
  /** Where ephemeral and ratchet keys come from. Defaults to `crypto.getRandomValues`. */
  readonly random?: RandomSource;
  /** Skipped-key caps. */
  readonly limits?: SkippedKeyLimits;
}

/** What the keys a received key exchange refers to, resolved against our own storage. */
export interface AcceptKeys {
  /** Our identity key pair. */
  readonly identityKey: KeyPair;
  /** The signed prekey the exchange named — the current one or the retained previous one. */
  readonly signedPreKey: SignedPreKeyPair;
  /** The one-time prekey the exchange consumed. */
  readonly preKey: PreKeyPair;
}

/** A session established from a received key exchange, plus that message's plaintext. */
export interface AcceptedSession {
  /** The new session, already advanced past the message it was built from. */
  readonly session: Session;
  /** The 32 bytes of payload key material the first message carried. */
  readonly keyMaterial: Uint8Array;
}

function ratchetOptions(options: SessionOptions): RatchetOptions {
  return {
    profile: options.profile ?? LEGACY_PROFILE,
    random: options.random ?? defaultRandomSource,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  };
}

/** A Double Ratchet session with one remote device. */
export class Session {
  readonly #ratchet: Ratchet;
  readonly #ourIdentityKey: Uint8Array;
  readonly #theirIdentityKey: Uint8Array;
  readonly #profile: OmemoProfile;
  #pending: PendingKeyExchange | undefined;

  private constructor(
    ratchet: Ratchet,
    ourIdentityKey: Uint8Array,
    theirIdentityKey: Uint8Array,
    profile: OmemoProfile,
    pending: PendingKeyExchange | undefined,
  ) {
    this.#ratchet = ratchet;
    this.#ourIdentityKey = ourIdentityKey;
    this.#theirIdentityKey = theirIdentityKey;
    this.#profile = profile;
    this.#pending = pending;
  }

  /**
   * Start a session from a peer's fetched bundle.
   *
   * Nothing is sent yet and nothing of the peer's is consumed on our side — but the prekey id is
   * now spoken for, so the caller must not hand the same `BundleKeys` to a second session.
   */
  static async initiate(
    identityKey: KeyPair,
    bundle: BundleKeys,
    options: SessionOptions = {},
  ): Promise<Session> {
    const profile = options.profile ?? LEGACY_PROFILE;
    const random = options.random ?? defaultRandomSource;
    const { secret, ephemeralKey } = await x3dhActive(identityKey, bundle, random, profile);
    const ratchet = await Ratchet.initActive(secret, bundle.signedPreKey, ratchetOptions(options));
    return new Session(ratchet, identityKey.publicKey, bundle.identityKey, profile, {
      preKeyId: bundle.preKeyId,
      signedPreKeyId: bundle.signedPreKeyId,
      ephemeralKey: ephemeralKey.publicKey,
      identityKey: identityKey.publicKey,
    });
  }

  /**
   * Build a session from a received `OMEMOKeyExchange` and decrypt the message inside it.
   *
   * The two are one operation on purpose. The exchange's inner message is what proves the sender
   * holds the keys the exchange claims, so a session that cannot decrypt it must not exist — and
   * the prekey it consumed must not be deleted. Returning the key material together with the
   * session is what lets the caller commit both or neither.
   */
  static async accept(
    keys: AcceptKeys,
    exchange: OmemoKeyExchange,
    options: SessionOptions = {},
  ): Promise<AcceptedSession> {
    const profile = options.profile ?? LEGACY_PROFILE;
    if (exchange.signedPreKeyId !== keys.signedPreKey.id) {
      throw new KeyExchangeFailedError(
        `key exchange names signed prekey ${exchange.signedPreKeyId}, got ${keys.signedPreKey.id}`,
      );
    }
    if (exchange.preKeyId !== keys.preKey.id) {
      throw new KeyExchangeFailedError(`key exchange names prekey ${exchange.preKeyId}, got ${keys.preKey.id}`);
    }

    const secret = await x3dhPassive(
      {
        identityKey: keys.identityKey,
        signedPreKey: keys.signedPreKey,
        preKey: keys.preKey,
        theirIdentityKey: exchange.identityKey,
        theirEphemeralKey: exchange.ephemeralKey,
      },
      profile,
    );
    // The initiator's ratchet key is in the header of the message it wrapped, so the inner
    // message has to be read before the ratchet can be started at all.
    const theirRatchetKey = readRatchetKey(exchange.message, profile);
    const ratchet = await Ratchet.initPassive(secret, keys.signedPreKey, theirRatchetKey, ratchetOptions(options));
    const session = new Session(
      ratchet,
      keys.identityKey.publicKey,
      exchange.identityKey,
      profile,
      undefined,
    );
    const keyMaterial = await session.decrypt(exchange.message);
    return { session, keyMaterial };
  }

  /** Restore a stored session. */
  static fromRecord(record: SessionRecord, options: SessionOptions = {}): Session {
    const profile = options.profile ?? LEGACY_PROFILE;
    if (record.version !== profile.version) {
      throw new KeyExchangeFailedError(`stored session speaks ${record.version}, not ${profile.version}`);
    }
    const pending = record.pendingKeyExchange;
    return new Session(
      Ratchet.fromRecord(record.ratchet, ratchetOptions(options)),
      fromBase64(record.ourIdentityKey),
      fromBase64(record.theirIdentityKey),
      profile,
      pending === undefined
        ? undefined
        : {
            preKeyId: pending.preKeyId,
            signedPreKeyId: pending.signedPreKeyId,
            ephemeralKey: fromBase64(pending.ephemeralKey),
            identityKey: fromBase64(pending.identityKey),
          },
    );
  }

  /** The peer device's identity public key, raw — what a fingerprint is taken of. */
  get theirIdentityKey(): Uint8Array {
    return this.#theirIdentityKey.slice();
  }

  /**
   * Whether outgoing messages are still wrapped in a key exchange.
   *
   * True until the peer's first message arrives. Worth exposing because an unanswered exchange
   * after a long while is what the "resend an empty OMEMO message" upkeep looks at.
   */
  get hasPendingKeyExchange(): boolean {
    return this.#pending !== undefined;
  }

  /** How many messages this session has sent on its current chain. */
  get sendingChainLength(): number {
    return this.#ratchet.sendingChainLength;
  }

  /**
   * Encrypt 32 bytes of payload key material for this device.
   *
   * The associated data puts OUR identity key first, because we are sending. A key exchange
   * wraps the result while one is pending; the inner message is identical either way, so the
   * peer's ratchet sees the same bytes whichever wrapper arrives first.
   */
  async encrypt(keyMaterial: Uint8Array): Promise<OutgoingMessage> {
    const message = await this.#ratchet.encrypt(
      keyMaterial,
      associatedData(this.#ourIdentityKey, this.#theirIdentityKey),
    );
    const pending = this.#pending;
    if (pending === undefined) return { kind: 'message', bytes: message };
    return {
      kind: 'key-exchange',
      bytes: encodeKeyExchange(
        {
          preKeyId: pending.preKeyId,
          signedPreKeyId: pending.signedPreKeyId,
          ephemeralKey: pending.ephemeralKey,
          identityKey: pending.identityKey,
          message,
        },
        this.#profile,
      ),
    };
  }

  /**
   * Decrypt an `OMEMOAuthenticatedMessage` back to its 32 bytes of key material.
   *
   * The associated data puts THEIR identity key first. A success also clears the pending key
   * exchange — the peer has demonstrably processed it, so continuing to resend it would only
   * invite them to consume the same prekey again.
   */
  async decrypt(bytes: Uint8Array): Promise<Uint8Array> {
    const keyMaterial = await this.#ratchet.decrypt(
      bytes,
      associatedData(this.#theirIdentityKey, this.#ourIdentityKey),
    );
    this.#pending = undefined;
    return keyMaterial;
  }

  /**
   * Decrypt a message that arrived wrapped in a key exchange on an EXISTING session.
   *
   * Normal rather than exceptional: the peer keeps wrapping until one of its messages gets a
   * reply, so every message of theirs before our first answer looks like this. The exchange's
   * own fields are ignored — a session already exists, and re-running the agreement would
   * replace a live ratchet with a fresh one and lose every key in it.
   */
  async decryptKeyExchange(bytes: Uint8Array): Promise<Uint8Array> {
    return this.decrypt(decodeKeyExchange(bytes, this.#profile).message);
  }

  /** The session as a JSON-serializable record. */
  toRecord(): SessionRecord {
    const pending = this.#pending;
    return {
      version: this.#profile.version,
      ourIdentityKey: toBase64(this.#ourIdentityKey),
      theirIdentityKey: toBase64(this.#theirIdentityKey),
      ratchet: this.#ratchet.toRecord(),
      pendingKeyExchange:
        pending === undefined
          ? undefined
          : {
              preKeyId: pending.preKeyId,
              signedPreKeyId: pending.signedPreKeyId,
              ephemeralKey: toBase64(pending.ephemeralKey),
              identityKey: toBase64(pending.identityKey),
            },
    };
  }
}

/** The sender's ratchet public key out of a serialized `OMEMOAuthenticatedMessage`. */
function readRatchetKey(message: Uint8Array, profile: OmemoProfile): Uint8Array {
  return splitAuthenticatedMessage(message, profile).message.ratchetPublicKey;
}
