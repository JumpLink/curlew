/**
 * A device bundle: the public keys one device publishes so strangers can start a session with it
 * without it being online.
 *
 * This module is pure data plus two decisions — which prekey to spend, and whether the bundle is
 * self-consistent. Fetching and publishing it over PEP is the stanza layer's job (stage 2); the
 * shape here is XEP-0384 §4.2's `<bundle>` with the prefix bytes already stripped.
 */

import { bytesEqual } from './bytes.ts';
import { defaultRandomSource, randomBytes, type RandomSource } from './crypto.ts';
import { KeyExchangeFailedError } from './errors.ts';
import {
  verifyPreKeySignature,
  type KeyPair,
  type PreKeyPair,
  type SignedPreKeyPair,
} from './keys.ts';
import { LEGACY_PROFILE, type OmemoProfile } from './profile.ts';
import type { BundleKeys } from './x3dh.ts';

/** One published prekey. */
export interface PublishedPreKey {
  /** The id the bundle advertises it under. */
  readonly id: number;
  /** Its public half, raw (no `0x05` prefix). */
  readonly publicKey: Uint8Array;
}

/** Everything a device publishes about itself. */
export interface DeviceBundle {
  /** The device's long-term identity public key, raw. */
  readonly identityKey: Uint8Array;
  /** The id of the current signed prekey. */
  readonly signedPreKeyId: number;
  /** The current signed prekey's public half, raw. */
  readonly signedPreKey: Uint8Array;
  /** The identity key's XEdDSA signature over the encoded signed prekey. */
  readonly signedPreKeySignature: Uint8Array;
  /** The unused one-time prekeys, in no particular order. */
  readonly preKeys: readonly PublishedPreKey[];
}

/** Build the bundle to publish from this device's own key material. */
export function buildBundle(
  identityKey: KeyPair,
  signedPreKey: SignedPreKeyPair,
  preKeys: readonly PreKeyPair[],
): DeviceBundle {
  return {
    identityKey: identityKey.publicKey,
    signedPreKeyId: signedPreKey.id,
    signedPreKey: signedPreKey.publicKey,
    signedPreKeySignature: signedPreKey.signature,
    preKeys: preKeys.map((preKey) => ({ id: preKey.id, publicKey: preKey.publicKey })),
  };
}

/**
 * Whether a fetched bundle is usable: the signature verifies and there is a prekey to spend.
 *
 * Both are hard requirements rather than warnings. A bad signature means the bundle was not
 * published by the holder of that identity key, and an empty prekey list means the peer has run
 * out — in both cases there is nothing to do but refuse, and refusing with a reason beats
 * building a session that silently belongs to someone else.
 */
export function assertBundleUsable(bundle: DeviceBundle): void {
  if (!verifyPreKeySignature(bundle.identityKey, bundle.signedPreKey, bundle.signedPreKeySignature)) {
    throw new KeyExchangeFailedError('the signature on the bundle’s signed prekey does not verify');
  }
  if (bundle.preKeys.length === 0) {
    throw new KeyExchangeFailedError('the bundle advertises no unused prekeys');
  }
}

/**
 * Pick one prekey from a bundle and return the keys the active agreement needs.
 *
 * The choice is RANDOM, not the first entry. XEP-0384 §4.3 asks for it, and the reason is
 * collision: several of our devices may fetch the same bundle before the peer republishes, and
 * all picking `preKeys[0]` would make them all consume the same prekey — after which only the
 * first session the peer processes survives.
 */
export function selectBundleKeys(
  bundle: DeviceBundle,
  random: RandomSource = defaultRandomSource,
): BundleKeys {
  assertBundleUsable(bundle);
  const index = randomBytes(4, random).reduce((acc, byte) => acc * 256 + byte, 0) % bundle.preKeys.length;
  const preKey = bundle.preKeys[index]!;
  return {
    identityKey: bundle.identityKey,
    signedPreKeyId: bundle.signedPreKeyId,
    signedPreKey: bundle.signedPreKey,
    signedPreKeySignature: bundle.signedPreKeySignature,
    preKeyId: preKey.id,
    preKey: preKey.publicKey,
  };
}

/** Whether the bundle needs topping up with fresh prekeys. */
export function needsPreKeyRefill(bundle: DeviceBundle, profile: OmemoProfile = LEGACY_PROFILE): boolean {
  return bundle.preKeys.length < profile.preKeyRefillThreshold;
}

/** Whether two bundles advertise the same identity key. */
export function sameIdentity(a: DeviceBundle, b: DeviceBundle): boolean {
  return bytesEqual(a.identityKey, b.identityKey);
}
