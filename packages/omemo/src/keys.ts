/**
 * Key pairs, their serialized form on the wire, and the XEdDSA signature over a signed prekey.
 *
 * Every key in legacy OMEMO is Curve25519 — including the identity key, which OMEMO 2 and
 * python-omemo instead keep as Ed25519 and convert on the way out. Storing the Curve25519 form is
 * what the wire wants, so there is no conversion anywhere in this package except inside
 * {@link signPreKey} / {@link verifyPreKeySignature}, where XEdDSA needs the Edwards form.
 */

import { KEY_LENGTH, RANDOM_LENGTH, SIGNATURE_LENGTH, xeddsaSign, xeddsaVerify } from '@gjsify/xeddsa';
import { assertLength, concatBytes } from './bytes.ts';
import { defaultRandomSource, randomBytes, x25519PublicKey, type RandomSource } from './crypto.ts';
import { WireFormatError } from './errors.ts';

/** Length of a raw Curve25519 key, public or private. */
export const KEY_BYTES = KEY_LENGTH;

/** Length of a public key in the `0x05`-prefixed network format. */
export const ENCODED_KEY_BYTES = KEY_BYTES + 1;

/** Length of an XEdDSA signature. */
export const SIGNATURE_BYTES = SIGNATURE_LENGTH;

/**
 * libsignal's type byte for a Curve25519 (`DJB`) key, which prefixes every public key on the
 * wire: `Curve.DJB_TYPE`.
 */
const DJB_TYPE = 0x05;

/** A Curve25519 key pair. Both halves are raw 32-byte values, no type prefix. */
export interface KeyPair {
  /** The 32-byte private scalar. */
  readonly privateKey: Uint8Array;
  /** The 32-byte public key in Montgomery form. */
  readonly publicKey: Uint8Array;
}

/** A prekey: a key pair plus the id the bundle advertises it under. */
export interface PreKeyPair extends KeyPair {
  /** The id this prekey is published and referenced by. */
  readonly id: number;
}

/** A signed prekey: a prekey plus the identity key's signature over its public half. */
export interface SignedPreKeyPair extends PreKeyPair {
  /** XEdDSA signature by the identity key over the encoded public key. */
  readonly signature: Uint8Array;
}

/** Wrap a raw 32-byte public key in the `0x05` network format. */
export function encodePublicKey(publicKey: Uint8Array): Uint8Array {
  assertLength('public key', publicKey, KEY_BYTES);
  const out = new Uint8Array(ENCODED_KEY_BYTES);
  out[0] = DJB_TYPE;
  out.set(publicKey, 1);
  return out;
}

/**
 * Unwrap a public key from the network format.
 *
 * A bare 32-byte key is accepted too: some implementations publish the identity key in a bundle
 * without the prefix, and rejecting those would make their devices permanently unreachable for no
 * security gain — the length and the prefix carry no secret.
 */
export function decodePublicKey(bytes: Uint8Array): Uint8Array {
  if (bytes.length === ENCODED_KEY_BYTES) {
    if (bytes[0] !== DJB_TYPE) {
      throw new WireFormatError(`public key has type byte 0x${bytes[0]!.toString(16)}, expected 0x05`);
    }
    return bytes.slice(1);
  }
  if (bytes.length === KEY_BYTES) return bytes.slice();
  throw new WireFormatError(`public key is ${bytes.length} bytes, expected ${ENCODED_KEY_BYTES} or ${KEY_BYTES}`);
}

/** Generate a Curve25519 key pair. */
export function generateKeyPair(random: RandomSource = defaultRandomSource): KeyPair {
  const privateKey = randomBytes(KEY_BYTES, random);
  return { privateKey, publicKey: x25519PublicKey(privateKey) };
}

/** The key pair for a private scalar that came out of storage or a fixture. */
export function keyPairFromPrivate(privateKey: Uint8Array): KeyPair {
  assertLength('private key', privateKey, KEY_BYTES);
  return { privateKey: privateKey.slice(), publicKey: x25519PublicKey(privateKey) };
}

/** Generate `count` prekeys with ids counting up from `firstId`. */
export function generatePreKeys(
  firstId: number,
  count: number,
  random: RandomSource = defaultRandomSource,
): PreKeyPair[] {
  const out: PreKeyPair[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ id: firstId + i, ...generateKeyPair(random) });
  }
  return out;
}

/**
 * Sign a prekey's public half with the identity key.
 *
 * The signature covers the ENCODED public key (`0x05 || key`), not the raw 32 bytes — which is
 * what libsignal signs and what python-x3dh's `_encode_public_key` feeds to XEdDSA. Signing the
 * raw key produces a signature every other client rejects.
 */
export function signPreKey(
  identityPrivateKey: Uint8Array,
  preKeyPublic: Uint8Array,
  random: RandomSource = defaultRandomSource,
): Uint8Array {
  return xeddsaSign(identityPrivateKey, encodePublicKey(preKeyPublic), randomBytes(RANDOM_LENGTH, random));
}

/** Whether `signature` is a valid identity-key signature over `preKeyPublic`. */
export function verifyPreKeySignature(
  identityPublicKey: Uint8Array,
  preKeyPublic: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (signature.length !== SIGNATURE_BYTES) return false;
  return xeddsaVerify(identityPublicKey, encodePublicKey(preKeyPublic), signature);
}

/** Generate a signed prekey under `id`, signed by `identityKey`. */
export function generateSignedPreKey(
  identityKey: KeyPair,
  id: number,
  random: RandomSource = defaultRandomSource,
): SignedPreKeyPair {
  const pair = generateKeyPair(random);
  return { id, ...pair, signature: signPreKey(identityKey.privateKey, pair.publicKey, random) };
}

/**
 * The associated data the ratchet authenticates: the two identity keys in network format,
 * sender first.
 *
 * The ORDER is per-message and not per-session, which is the part worth being careful about.
 * python-oldmemo stores `initiatorIK || responderIK` once and swaps the halves whenever the local
 * side is the passive sender or the active receiver, calling it undocumented libsignal behaviour.
 * Expressed as sender/recipient it is simply: whoever sends comes first. A session that gets this
 * backwards authenticates every message against the wrong bytes and fails with a bad MAC.
 */
export function associatedData(senderIdentityKey: Uint8Array, recipientIdentityKey: Uint8Array): Uint8Array {
  return concatBytes(encodePublicKey(senderIdentityKey), encodePublicKey(recipientIdentityKey));
}
