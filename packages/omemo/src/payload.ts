/**
 * The payload cipher: the one AES key that encrypts the message body, independent of how many
 * devices are addressed.
 *
 * A message is encrypted ONCE under a fresh AES-128-GCM key, and that key is then encrypted
 * per recipient device through its own ratchet. So a conversation with eight devices carries one
 * payload and eight small `<key>` elements, not eight payloads.
 *
 * The part that surprises everyone reading the XEP for the first time: the GCM **authentication
 * tag does not travel with the ciphertext**. It is appended to the key, so the 32 bytes going
 * through each ratchet are `key16 || tag16` and `<payload>` holds the bare ciphertext. The reason
 * is that the tag is what makes the payload unforgeable, and leaving it next to the ciphertext
 * would let anyone who is not a recipient re-encrypt the body. python-oldmemo splits at exactly
 * this boundary (`encrypt_key_material` / the 16-byte `key`/`tag` halves).
 *
 * AES-**128**, not 256: legacy OMEMO's key is 16 bytes. Using 32 produces a payload no other
 * client can read.
 */

import { assertLength, concatBytes } from './bytes.ts';
import { aesGcmDecrypt, aesGcmEncrypt, defaultRandomSource, randomBytes, type RandomSource } from './crypto.ts';
import { WireFormatError } from './errors.ts';
import { LEGACY_PROFILE, type OmemoProfile } from './profile.ts';

/** An encrypted message body and the secrets that open it. */
export interface EncryptedPayload {
  /** The AES-GCM ciphertext WITHOUT its tag — what `<payload>` carries, base64-encoded. */
  readonly ciphertext: Uint8Array;
  /** The IV, what `<iv>` carries. 12 bytes for anything this package produces. */
  readonly iv: Uint8Array;
  /**
   * `key || tag`: the 32 bytes that go through each recipient's ratchet. Never leaves the device
   * unencrypted.
   */
  readonly keyMaterial: Uint8Array;
}

/** Encrypt a message body under a fresh key. */
export async function encryptPayload(
  plaintext: Uint8Array,
  random: RandomSource = defaultRandomSource,
  profile: OmemoProfile = LEGACY_PROFILE,
): Promise<EncryptedPayload> {
  const key = randomBytes(profile.payloadKeyLength, random);
  const iv = randomBytes(profile.payloadIvLength, random);
  const sealed = await aesGcmEncrypt(key, iv, plaintext);
  const split = sealed.length - profile.payloadTagLength;
  return {
    ciphertext: sealed.subarray(0, split),
    iv,
    keyMaterial: concatBytes(key, sealed.subarray(split)),
  };
}

/**
 * Decrypt a message body given the key material its ratchet yielded.
 *
 * `iv` is taken as received rather than checked against `payloadIvLength`: Conversations used to
 * send 16-byte IVs, and archives full of those messages still exist. GCM accepts any IV length,
 * so the only cost of accepting them is that the underlying implementation must too — which is
 * why one test for this is conditional (see the note in the unit tests).
 */
export async function decryptPayload(
  ciphertext: Uint8Array,
  iv: Uint8Array,
  keyMaterial: Uint8Array,
  profile: OmemoProfile = LEGACY_PROFILE,
): Promise<Uint8Array> {
  const expected = profile.payloadKeyLength + profile.payloadTagLength;
  if (keyMaterial.length !== expected) {
    throw new WireFormatError(`key material is ${keyMaterial.length} bytes, expected ${expected}`);
  }
  const key = keyMaterial.subarray(0, profile.payloadKeyLength);
  const tag = keyMaterial.subarray(profile.payloadKeyLength);
  return aesGcmDecrypt(key, iv, concatBytes(ciphertext, tag));
}

/** Split `key || tag` into its halves, for a caller that needs them apart. */
export function splitKeyMaterial(
  keyMaterial: Uint8Array,
  profile: OmemoProfile = LEGACY_PROFILE,
): { readonly key: Uint8Array; readonly tag: Uint8Array } {
  assertLength('key material', keyMaterial, profile.payloadKeyLength + profile.payloadTagLength);
  return {
    key: keyMaterial.subarray(0, profile.payloadKeyLength),
    tag: keyMaterial.subarray(profile.payloadKeyLength),
  };
}
