/**
 * X3DH: the key agreement that brings a session into existence.
 *
 * Two sides, deliberately not symmetric. The ACTIVE side has the other's published bundle and
 * picks an ephemeral key; the PASSIVE side has a key exchange that names which of its own keys
 * were used. Three or four Diffie-Hellman outputs are concatenated behind 32 `0xFF` bytes and run
 * through HKDF.
 *
 * The one thing worth stating plainly, because the two reference implementations look different:
 *
 *   python-x3dh derives **32** bytes here and hands them to python-doubleratchet as the root key.
 *   libsignal derives **64** and splits them into a root key and an initial chain key.
 *
 * These agree rather than conflict. HKDF-Expand emits `T(1) | T(2) | …`, so the 32-byte output is
 * byte-for-byte the first half of the 64-byte one: python's root key IS libsignal's root key, and
 * libsignal's initial chain key is the half python never asks for. So 64 bytes are derived here —
 * the superset — and {@link ratchetInitActive} explains what the second half is good for.
 */

import { concatBytes } from './bytes.ts';
import { hkdfSha256, x25519, type RandomSource } from './crypto.ts';
import { KeyExchangeFailedError } from './errors.ts';
import {
  associatedData,
  generateKeyPair,
  verifyPreKeySignature,
  type KeyPair,
  type PreKeyPair,
  type SignedPreKeyPair,
} from './keys.ts';
import { LEGACY_PROFILE, type OmemoProfile } from './profile.ts';

/** The 32 `0xFF` bytes in front of the DH outputs: libsignal's `getDiscontinuityBytes`. */
const DISCONTINUITY = new Uint8Array(32).fill(0xff);

/** The HKDF salt for the X3DH step and for every message-key derivation: 32 zero bytes. */
const ZERO_SALT = new Uint8Array(32);

/** What a key agreement produces. */
export interface SharedSecret {
  /** The root key the Diffie-Hellman ratchet starts from (libsignal's first 32 bytes). */
  readonly rootKey: Uint8Array;
  /** libsignal's initial chain key — the second 32 bytes. See {@link ratchetInitActive}. */
  readonly initialChainKey: Uint8Array;
  /** `senderIK || recipientIK` from the active side's point of view, i.e. initiator first. */
  readonly associatedData: Uint8Array;
}

async function deriveSharedSecret(
  dhOutputs: readonly Uint8Array[],
  ad: Uint8Array,
  profile: OmemoProfile,
): Promise<SharedSecret> {
  const master = concatBytes(DISCONTINUITY, ...dhOutputs);
  const derived = await hkdfSha256(master, ZERO_SALT, profile.x3dhInfo, 64);
  return { rootKey: derived.subarray(0, 32), initialChainKey: derived.subarray(32, 64), associatedData: ad };
}

/** The public half of a device's bundle, as far as the key agreement needs it. */
export interface BundleKeys {
  /** The device's long-term identity public key, raw. */
  readonly identityKey: Uint8Array;
  /** The id of the signed prekey being used. */
  readonly signedPreKeyId: number;
  /** The signed prekey's public half, raw. */
  readonly signedPreKey: Uint8Array;
  /** The identity key's signature over the encoded signed prekey. */
  readonly signedPreKeySignature: Uint8Array;
  /** The id of the chosen one-time prekey. */
  readonly preKeyId: number;
  /** The chosen one-time prekey's public half, raw. */
  readonly preKey: Uint8Array;
}

/** The active side's result: the secret plus the keys the other side needs to catch up. */
export interface ActiveAgreement {
  /** The derived secret and associated data. */
  readonly secret: SharedSecret;
  /** The ephemeral key pair generated for this agreement. */
  readonly ephemeralKey: KeyPair;
}

/**
 * Run the key agreement as the initiator, against a fetched bundle.
 *
 * The signed prekey's signature is verified FIRST and a failure aborts: an unsigned or
 * badly-signed prekey means the bundle did not come from the holder of that identity key, and
 * continuing would build a session with whoever tampered with it.
 */
export async function x3dhActive(
  identityKey: KeyPair,
  bundle: BundleKeys,
  random?: RandomSource,
  profile: OmemoProfile = LEGACY_PROFILE,
): Promise<ActiveAgreement> {
  if (!verifyPreKeySignature(bundle.identityKey, bundle.signedPreKey, bundle.signedPreKeySignature)) {
    throw new KeyExchangeFailedError('the signature on the signed prekey does not verify');
  }
  const ephemeralKey = generateKeyPair(random);
  const dh1 = await x25519(identityKey.privateKey, bundle.signedPreKey);
  const dh2 = await x25519(ephemeralKey.privateKey, bundle.identityKey);
  const dh3 = await x25519(ephemeralKey.privateKey, bundle.signedPreKey);
  const dh4 = await x25519(ephemeralKey.privateKey, bundle.preKey);
  const ad = associatedData(identityKey.publicKey, bundle.identityKey);
  return { secret: await deriveSharedSecret([dh1, dh2, dh3, dh4], ad, profile), ephemeralKey };
}

/** The keys a received key exchange refers to, resolved against our own storage. */
export interface PassiveKeys {
  /** Our identity key pair. */
  readonly identityKey: KeyPair;
  /** The signed prekey the exchange named — current or the retained previous one. */
  readonly signedPreKey: SignedPreKeyPair;
  /** The one-time prekey the exchange consumed. */
  readonly preKey: PreKeyPair;
  /** The initiator's identity public key, raw. */
  readonly theirIdentityKey: Uint8Array;
  /** The initiator's ephemeral public key, raw. */
  readonly theirEphemeralKey: Uint8Array;
}

/**
 * Run the key agreement as the responder.
 *
 * Mirrors the active side: each DH swaps which side contributes the private half, so `dh1` pairs
 * our signed prekey with their identity key where the initiator paired its identity key with our
 * signed prekey. The associated data keeps the INITIATOR first — it is a property of the session,
 * not of who is computing it, and `associatedData` is re-ordered per message direction later.
 */
export async function x3dhPassive(
  keys: PassiveKeys,
  profile: OmemoProfile = LEGACY_PROFILE,
): Promise<SharedSecret> {
  const dh1 = await x25519(keys.signedPreKey.privateKey, keys.theirIdentityKey);
  const dh2 = await x25519(keys.identityKey.privateKey, keys.theirEphemeralKey);
  const dh3 = await x25519(keys.signedPreKey.privateKey, keys.theirEphemeralKey);
  const dh4 = await x25519(keys.preKey.privateKey, keys.theirEphemeralKey);
  const ad = associatedData(keys.theirIdentityKey, keys.identityKey.publicKey);
  return deriveSharedSecret([dh1, dh2, dh3, dh4], ad, profile);
}
