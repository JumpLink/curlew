/**
 * The Double Ratchet: the root chain, the two symmetric chains, and the skipped-key store.
 *
 * Three chains, each a KDF chain. The ROOT chain is stepped with a Diffie-Hellman output whenever
 * the peer's ratchet key changes and emits a fresh chain key; the SENDING and RECEIVING chains are
 * stepped per message and emit message keys. A message key is never reused and never recoverable
 * once stepped past, which is where forward secrecy comes from — and why an out-of-order message
 * needs its key stored ahead of time rather than re-derived later.
 *
 * Two invariants hold the whole thing together:
 *
 *  - **A failed decryption must not advance the ratchet.** The Double Ratchet specification says
 *    to work on a clone and keep it only on success; python-doubleratchet does literally that, and
 *    so does {@link Ratchet.decrypt} via {@link Ratchet.snapshot}. Without it, one forged message
 *    with a plausible header would skip the session forward and destroy every key in between.
 *  - **The skipped-key store is bounded.** Both limits exist because the peer picks the numbers:
 *    `maxSkippedKeysPerMessage` caps how many keys ONE message may ask to be derived, and
 *    `maxSkippedKeysPerSession` caps how many are retained.
 *
 * The AEAD here is the ratchet's own (AES-256-CBC + truncated HMAC over 32 bytes of key
 * material), not the payload cipher — {@link payload} holds that one.
 */

import { bytesEqual, concatBytes, fromBase64, toBase64 } from './bytes.ts';
import {
  aesCbcDecrypt,
  aesCbcEncrypt,
  defaultRandomSource,
  hkdfSha256,
  hmacSha256,
  x25519,
  type RandomSource,
} from './crypto.ts';
import {
  AuthenticationFailedError,
  DuplicateMessageError,
  SkippedKeyLimitError,
} from './errors.ts';
import { generateKeyPair, keyPairFromPrivate, type KeyPair } from './keys.ts';
import { LEGACY_PROFILE, type OmemoProfile } from './profile.ts';
import type { SharedSecret } from './x3dh.ts';
import {
  encodeAuthenticatedMessage,
  encodeMessage,
  splitAuthenticatedMessage,
  type OmemoMessage,
} from './wire.ts';

/** The HKDF salt for a message-key derivation: 32 zero bytes. */
const ZERO_SALT = new Uint8Array(32);

/** The two constants a symmetric chain is stepped with: libsignal's `ChainKey` seeds. */
const MESSAGE_KEY_SEED = Uint8Array.of(0x01);
const CHAIN_KEY_SEED = Uint8Array.of(0x02);

/** Default for both skipped-key limits, as python-doubleratchet and Conversations use. */
export const DEFAULT_MAX_SKIPPED_KEYS = 1000;

/** How many skipped message keys a session will derive and retain. */
export interface SkippedKeyLimits {
  /** Cap on keys ONE message may ask to be derived on the current receiving chain. */
  readonly maxSkippedKeysPerMessage: number;
  /** Cap on keys retained across the session; the oldest are dropped first. */
  readonly maxSkippedKeysPerSession: number;
}

/** Both limits at their defaults. */
export const DEFAULT_SKIPPED_KEY_LIMITS: SkippedKeyLimits = {
  maxSkippedKeysPerMessage: DEFAULT_MAX_SKIPPED_KEYS,
  maxSkippedKeysPerSession: DEFAULT_MAX_SKIPPED_KEYS,
};

/** One symmetric chain: its current key and how many keys it has emitted. */
interface Chain {
  chainKey: Uint8Array;
  length: number;
}

/** A message key derived early because its message had not arrived yet. */
interface SkippedKey {
  /** The ratchet key the chain it came from belonged to. */
  readonly ratchetKey: Uint8Array;
  /** Its index in that chain. */
  readonly index: number;
  /** The 32-byte message key. */
  readonly messageKey: Uint8Array;
}

/** The ratchet's mutable state. Cloned wholesale around a decryption attempt. */
interface RatchetState {
  rootKey: Uint8Array;
  ownRatchetKey: KeyPair;
  theirRatchetKey: Uint8Array | undefined;
  sending: Chain | undefined;
  receiving: Chain | undefined;
  previousSendingLength: number;
  skipped: SkippedKey[];
}

/** The three keys one message key expands into. */
interface MessageKeys {
  readonly cipherKey: Uint8Array;
  readonly macKey: Uint8Array;
  readonly iv: Uint8Array;
}

/**
 * Expand a 32-byte message key into the AES key, the MAC key and the IV.
 *
 * 80 bytes from HKDF under `WhisperMessageKeys`, split 32/32/16 — libsignal's `ChainKey`
 * derivation. The IV comes out of the KDF rather than travelling with the message, which is why
 * an `OMEMOMessage` has no IV field.
 */
async function deriveMessageKeys(messageKey: Uint8Array, profile: OmemoProfile): Promise<MessageKeys> {
  const out = await hkdfSha256(messageKey, ZERO_SALT, profile.messageKeysInfo, 80);
  return { cipherKey: out.subarray(0, 32), macKey: out.subarray(32, 64), iv: out.subarray(64, 80) };
}

/** Step a symmetric chain: emit a message key and advance the chain key. */
async function stepChain(chain: Chain): Promise<Uint8Array> {
  const messageKey = await hmacSha256(chain.chainKey, MESSAGE_KEY_SEED);
  chain.chainKey = await hmacSha256(chain.chainKey, CHAIN_KEY_SEED);
  chain.length += 1;
  return messageKey;
}

function cloneChain(chain: Chain | undefined): Chain | undefined {
  return chain === undefined ? undefined : { chainKey: chain.chainKey.slice(), length: chain.length };
}

/** One symmetric chain, base64-encoded. */
export interface ChainRecord {
  /** The chain's current key, base64. */
  readonly chainKey: string;
  /** How many keys it has emitted. */
  readonly length: number;
}

/** A retained skipped message key, base64-encoded. */
export interface SkippedKeyRecord {
  /** The ratchet key of the chain it came from, base64. */
  readonly ratchetKey: string;
  /** Its index in that chain. */
  readonly index: number;
  /** The message key, base64. */
  readonly messageKey: string;
}

/** A ratchet's whole state, JSON-serializable. See {@link Ratchet.toRecord}. */
export interface RatchetStateRecord {
  /** The root chain's current key, base64. */
  readonly rootKey: string;
  /** The private half of our current ratchet key, base64; the public half is re-derived. */
  readonly ownRatchetPrivateKey: string;
  /** The peer's current ratchet public key, base64, or absent before the first one is known. */
  readonly theirRatchetKey?: string | undefined;
  /** The sending chain, absent while there is none. */
  readonly sending?: ChainRecord | undefined;
  /** The receiving chain, absent while there is none. */
  readonly receiving?: ChainRecord | undefined;
  /** How long the previous sending chain was — the `pn` of the next outgoing message. */
  readonly previousSendingLength: number;
  /** The retained skipped message keys, oldest first. */
  readonly skipped: readonly SkippedKeyRecord[];
}

function chainToRecord(chain: Chain | undefined): ChainRecord | undefined {
  return chain === undefined ? undefined : { chainKey: toBase64(chain.chainKey), length: chain.length };
}

function chainFromRecord(record: ChainRecord | undefined): Chain | undefined {
  return record === undefined ? undefined : { chainKey: fromBase64(record.chainKey), length: record.length };
}

/**
 * The ratchet of one session.
 *
 * Construct it through {@link Ratchet.initActive} / {@link Ratchet.initPassive} for a new session
 * or {@link Ratchet.fromRecord} for a stored one. The associated data is passed per call rather
 * than held here: it is direction-dependent, and the session layer owns the identity keys that
 * determine the order.
 */
export class Ratchet {
  #state: RatchetState;
  readonly #profile: OmemoProfile;
  readonly #limits: SkippedKeyLimits;
  readonly #random: RandomSource;

  private constructor(
    state: RatchetState,
    profile: OmemoProfile,
    limits: SkippedKeyLimits,
    random: RandomSource,
  ) {
    this.#state = state;
    this.#profile = profile;
    this.#limits = limits;
    this.#random = random;
  }

  /**
   * Start the ratchet as the side that initiated the key agreement.
   *
   * `theirSignedPreKey` doubles as the peer's initial ratchet key, which is what makes the first
   * sending chain derivable before the peer has sent anything.
   *
   * The receiving chain installed here on `secret.initialChainKey` is libsignal's, not
   * python-doubleratchet's — python leaves the active side without one. It is the half of the
   * X3DH output python never asks for (see {@link x3dh}), and installing it costs nothing while
   * covering a libsignal peer whose first reply still uses the signed prekey as its ratchet key.
   * A python peer instead replies with a fresh key, which simply triggers the ordinary
   * Diffie-Hellman step; its `pn` is 0, so the unused chain yields no spurious skipped keys.
   */
  static async initActive(
    secret: SharedSecret,
    theirSignedPreKey: Uint8Array,
    options: RatchetOptions = {},
  ): Promise<Ratchet> {
    const profile = options.profile ?? LEGACY_PROFILE;
    const random = options.random ?? defaultRandomSource;
    const ownRatchetKey = generateKeyPair(random);
    const state: RatchetState = {
      rootKey: secret.rootKey.slice(),
      ownRatchetKey,
      theirRatchetKey: theirSignedPreKey.slice(),
      sending: undefined,
      receiving: { chainKey: secret.initialChainKey.slice(), length: 0 },
      previousSendingLength: 0,
      skipped: [],
    };
    const ratchet = new Ratchet(state, profile, options.limits ?? DEFAULT_SKIPPED_KEY_LIMITS, random);
    await ratchet.#replaceSendingChain();
    return ratchet;
  }

  /**
   * Start the ratchet as the side that received the key agreement.
   *
   * Two root steps, in this order: the receiving chain off our signed prekey against their
   * ratchet key, then a FRESH ratchet key of our own for the sending chain.
   *
   * Generating a fresh key is python-doubleratchet's behaviour and is the deliberate choice here.
   * libsignal instead keeps the signed prekey as its ratchet key and seeds the sending chain with
   * `initialChainKey`, so its first reply carries the signed prekey in the header. Either reply
   * is decryptable by a libsignal peer — it performs a Diffie-Hellman step on any unfamiliar
   * ratchet key — but only the fresh-key form is decryptable by a python peer, which has no
   * chain for the signed prekey at all. So this direction interoperates with both and libsignal's
   * would not.
   */
  static async initPassive(
    secret: SharedSecret,
    ourSignedPreKey: KeyPair,
    theirRatchetKey: Uint8Array,
    options: RatchetOptions = {},
  ): Promise<Ratchet> {
    const profile = options.profile ?? LEGACY_PROFILE;
    const random = options.random ?? defaultRandomSource;
    const state: RatchetState = {
      rootKey: secret.rootKey.slice(),
      ownRatchetKey: ourSignedPreKey,
      theirRatchetKey: theirRatchetKey.slice(),
      sending: undefined,
      receiving: undefined,
      previousSendingLength: 0,
      skipped: [],
    };
    const ratchet = new Ratchet(state, profile, options.limits ?? DEFAULT_SKIPPED_KEY_LIMITS, random);
    ratchet.#state.receiving = { chainKey: await ratchet.#rootStep(), length: 0 };
    ratchet.#state.ownRatchetKey = generateKeyPair(random);
    await ratchet.#replaceSendingChain();
    return ratchet;
  }

  /** How long the sending chain is — the `n` the next outgoing message will carry. */
  get sendingChainLength(): number {
    return this.#state.sending?.length ?? 0;
  }

  /** How long the receiving chain is, or `undefined` while there is none. */
  get receivingChainLength(): number | undefined {
    return this.#state.receiving?.length;
  }

  /** How many skipped message keys are currently retained. */
  get skippedKeyCount(): number {
    return this.#state.skipped.length;
  }

  /**
   * Encrypt 32 bytes of key material into a serialized `OMEMOAuthenticatedMessage`.
   *
   * `associatedData` must be the SENDING order (our identity key first). The MAC covers it
   * together with the version byte and the whole `OMEMOMessage`, so neither the header nor the
   * two identity keys can be altered in flight.
   */
  async encrypt(plaintext: Uint8Array, associatedData: Uint8Array): Promise<Uint8Array> {
    const sending = this.#state.sending;
    // Unreachable through the public constructors: both install a sending chain.
    if (sending === undefined) throw new Error('ratchet has no sending chain');

    const counter = sending.length;
    const messageKey = await stepChain(sending);
    const keys = await deriveMessageKeys(messageKey, this.#profile);
    const ciphertext = await aesCbcEncrypt(keys.cipherKey, keys.iv, plaintext);

    const message: OmemoMessage = {
      ratchetPublicKey: this.#state.ownRatchetKey.publicKey,
      counter,
      previousCounter: this.#state.previousSendingLength,
      ciphertext,
    };
    const macInput = concatBytes(associatedData, encodeMessage(message, this.#profile));
    const mac = (await hmacSha256(keys.macKey, macInput)).subarray(0, this.#profile.macLength);
    return encodeAuthenticatedMessage(message, mac, this.#profile);
  }

  /**
   * Decrypt a serialized `OMEMOAuthenticatedMessage` back to its 32 bytes of key material.
   *
   * `associatedData` must be the RECEIVING order (their identity key first). On any failure the
   * ratchet is left exactly as it was, so a rejected message costs nothing and the next genuine
   * one still decrypts.
   */
  async decrypt(bytes: Uint8Array, associatedData: Uint8Array): Promise<Uint8Array> {
    const { macInput, mac, message } = splitAuthenticatedMessage(bytes, this.#profile);
    const saved = this.snapshot();
    try {
      const messageKey = await this.#messageKeyFor(message);
      const keys = await deriveMessageKeys(messageKey, this.#profile);

      const expected = (await hmacSha256(keys.macKey, concatBytes(associatedData, macInput))).subarray(
        0,
        this.#profile.macLength,
      );
      if (!bytesEqual(expected, mac)) {
        throw new AuthenticationFailedError('the message authentication tag does not match');
      }

      const plaintext = await aesCbcDecrypt(keys.cipherKey, keys.iv, message.ciphertext);
      this.#trimSkippedKeys();
      return plaintext;
    } catch (err) {
      this.restore(saved);
      throw err;
    }
  }

  /**
   * The message key for `message`, advancing the ratchet as needed.
   *
   * A stored skipped key is consumed first and REMOVED, which is what makes a replayed
   * out-of-order message fail: the second copy finds no stored key and then trips the duplicate
   * check, because the chain has already moved past its index.
   */
  async #messageKeyFor(message: OmemoMessage): Promise<Uint8Array> {
    const state = this.#state;
    const storedAt = state.skipped.findIndex(
      (entry) => entry.index === message.counter && bytesEqual(entry.ratchetKey, message.ratchetPublicKey),
    );
    if (storedAt !== -1) {
      const [entry] = state.skipped.splice(storedAt, 1);
      return entry!.messageKey;
    }

    if (state.theirRatchetKey === undefined || !bytesEqual(state.theirRatchetKey, message.ratchetPublicKey)) {
      await this.#diffieHellmanStep(message);
    }

    const receiving = state.receiving;
    if (receiving === undefined) throw new DuplicateMessageError('no receiving chain for this message');

    const toSkip = Math.max(message.counter - receiving.length, 0);
    if (toSkip > this.#limits.maxSkippedKeysPerMessage) {
      throw new SkippedKeyLimitError(
        `message claims index ${message.counter} on a chain at ${receiving.length}, which would skip ` +
          `${toSkip} keys (limit ${this.#limits.maxSkippedKeysPerMessage})`,
      );
    }
    await this.#skipForward(toSkip, message.ratchetPublicKey);

    if (message.counter < receiving.length) {
      throw new DuplicateMessageError(`message index ${message.counter} was already decrypted`);
    }
    return stepChain(receiving);
  }

  /**
   * One full Diffie-Hellman step: derive any keys still missing from the old receiving chain,
   * then replace both chains.
   *
   * Crossing the limit here only SKIPS the derivation rather than throwing, unlike the per-chain
   * case. python-doubleratchet makes the same distinction, and the reason is recovery: after
   * heavy message loss a peer legitimately jumps far ahead, and refusing the step would wedge the
   * session for good instead of giving up some unrecoverable old messages.
   */
  async #diffieHellmanStep(message: OmemoMessage): Promise<void> {
    const state = this.#state;
    const receiving = state.receiving;
    if (receiving !== undefined && state.theirRatchetKey !== undefined) {
      const toSkip = Math.max(message.previousCounter - receiving.length, 0);
      if (toSkip <= this.#limits.maxSkippedKeysPerMessage) {
        await this.#skipForward(toSkip, state.theirRatchetKey);
      }
    }
    state.theirRatchetKey = message.ratchetPublicKey.slice();
    state.receiving = { chainKey: await this.#rootStep(), length: 0 };
    state.ownRatchetKey = generateKeyPair(this.#random);
    await this.#replaceSendingChain();
  }

  /** Derive `count` keys off the receiving chain and retain them under `ratchetKey`. */
  async #skipForward(count: number, ratchetKey: Uint8Array): Promise<void> {
    const receiving = this.#state.receiving;
    if (receiving === undefined) return;
    for (let i = 0; i < count; i++) {
      const index = receiving.length;
      this.#state.skipped.push({ ratchetKey: ratchetKey.slice(), index, messageKey: await stepChain(receiving) });
    }
  }

  /** Drop the oldest retained keys down to the session limit. */
  #trimSkippedKeys(): void {
    const excess = this.#state.skipped.length - this.#limits.maxSkippedKeysPerSession;
    if (excess > 0) this.#state.skipped.splice(0, excess);
  }

  /** Step the root chain with the current DH output and return the new chain key. */
  async #rootStep(): Promise<Uint8Array> {
    const state = this.#state;
    if (state.theirRatchetKey === undefined) throw new Error('ratchet has no peer ratchet key');
    const dh = await x25519(state.ownRatchetKey.privateKey, state.theirRatchetKey);
    const out = await hkdfSha256(dh, state.rootKey, this.#profile.rootChainInfo, 64);
    state.rootKey = out.slice(0, 32);
    return out.slice(32, 64);
  }

  /** Replace the sending chain, remembering how long the old one was for the next `pn`. */
  async #replaceSendingChain(): Promise<void> {
    const state = this.#state;
    state.previousSendingLength = state.sending?.length ?? 0;
    state.sending = { chainKey: await this.#rootStep(), length: 0 };
  }

  /**
   * The ratchet's state as a JSON-serializable record.
   *
   * Every byte field is base64, because ADR 0006 §3 stores a session as base64 TEXT and a
   * `Uint8Array` does not survive `JSON.stringify` — it comes back as an object with numeric
   * keys, silently, and the session then fails to decrypt rather than failing to load.
   */
  toRecord(): RatchetStateRecord {
    const state = this.#state;
    return {
      rootKey: toBase64(state.rootKey),
      ownRatchetPrivateKey: toBase64(state.ownRatchetKey.privateKey),
      theirRatchetKey: state.theirRatchetKey === undefined ? undefined : toBase64(state.theirRatchetKey),
      sending: chainToRecord(state.sending),
      receiving: chainToRecord(state.receiving),
      previousSendingLength: state.previousSendingLength,
      skipped: state.skipped.map((entry) => ({
        ratchetKey: toBase64(entry.ratchetKey),
        index: entry.index,
        messageKey: toBase64(entry.messageKey),
      })),
    };
  }

  /**
   * Rebuild a ratchet from {@link toRecord}.
   *
   * Only the private half of our ratchet key is stored; the public half is re-derived, which
   * keeps the record from carrying two values that could disagree.
   */
  static fromRecord(record: RatchetStateRecord, options: RatchetOptions = {}): Ratchet {
    const state: RatchetState = {
      rootKey: fromBase64(record.rootKey),
      ownRatchetKey: keyPairFromPrivate(fromBase64(record.ownRatchetPrivateKey)),
      theirRatchetKey: record.theirRatchetKey === undefined ? undefined : fromBase64(record.theirRatchetKey),
      sending: chainFromRecord(record.sending),
      receiving: chainFromRecord(record.receiving),
      previousSendingLength: record.previousSendingLength,
      skipped: record.skipped.map((entry) => ({
        ratchetKey: fromBase64(entry.ratchetKey),
        index: entry.index,
        messageKey: fromBase64(entry.messageKey),
      })),
    };
    return new Ratchet(
      state,
      options.profile ?? LEGACY_PROFILE,
      options.limits ?? DEFAULT_SKIPPED_KEY_LIMITS,
      options.random ?? defaultRandomSource,
    );
  }

  /** A deep copy of the current state, for {@link restore}. */
  snapshot(): RatchetState {
    const state = this.#state;
    return {
      rootKey: state.rootKey.slice(),
      ownRatchetKey: {
        privateKey: state.ownRatchetKey.privateKey.slice(),
        publicKey: state.ownRatchetKey.publicKey.slice(),
      },
      theirRatchetKey: state.theirRatchetKey?.slice(),
      sending: cloneChain(state.sending),
      receiving: cloneChain(state.receiving),
      previousSendingLength: state.previousSendingLength,
      skipped: state.skipped.map((entry) => ({
        ratchetKey: entry.ratchetKey.slice(),
        index: entry.index,
        messageKey: entry.messageKey.slice(),
      })),
    };
  }

  /** Put back a state taken by {@link snapshot}. */
  restore(state: RatchetState): void {
    this.#state = state;
  }
}

/** Construction-time knobs shared by both initialisers and {@link Ratchet.fromRecord}. */
export interface RatchetOptions {
  /** Which OMEMO profile to speak. Defaults to {@link LEGACY_PROFILE}. */
  readonly profile?: OmemoProfile;
  /** Where ratchet keys come from. Defaults to `crypto.getRandomValues`. */
  readonly random?: RandomSource;
  /** Skipped-key caps. Defaults to {@link DEFAULT_SKIPPED_KEY_LIMITS}. */
  readonly limits?: SkippedKeyLimits;
}
