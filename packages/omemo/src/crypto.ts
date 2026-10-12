/**
 * The cryptographic primitives the ratchet is built from, and the one seam that makes our own
 * output reproducible.
 *
 * Everything here goes through `globalThis.crypto` — WebCrypto, not `node:crypto`. The package
 * has to run unchanged on GJS and on Node, and on GJS `crypto.subtle` is the polyfill
 * `@gjsify/webcrypto/register`, which the bundler injects on its own because `--globals auto`
 * sees the free `crypto` reference. Verified on GJS 0.59.1: HMAC-SHA256, HKDF-SHA256, AES-CBC,
 * AES-GCM with a 12-byte IV, and X25519 `deriveBits` against the RFC 7748 §6.1 vector.
 *
 * Two shapes are worth knowing before reading on:
 *
 *  - WebCrypto has no way to hand it a raw X25519 scalar, so {@link x25519} wraps the 32 bytes in
 *    the fixed PKCS#8 prefix below. It also will not give back a public key, so
 *    {@link x25519PublicKey} goes the long way round through Ed25519 in `@gjsify/xeddsa` rather
 *    than hand-rolling a curve map.
 *  - AES-CBC in WebCrypto always applies PKCS#7 and always checks it on the way back, which is
 *    exactly what the ratchet layer wants: a wrong key surfaces as a thrown padding error.
 */

import { curveToEdPrivate, edToCurvePublic } from '@gjsify/xeddsa';
import { assertLength } from './bytes.ts';
import { DecryptionFailedError } from './errors.ts';

/**
 * Where random bytes come from.
 *
 * An explicit seam, not a convenience: the fixture tests compare OUR bytes against what
 * python-oldmemo recorded, and a message carries a freshly generated ratchet key and (for a key
 * exchange) an ephemeral key. With the randomness injected, a test can pin those and the
 * comparison is over the whole message rather than the handful of deterministic fields.
 *
 * Production never passes one — {@link defaultRandomSource} is the default everywhere.
 */
export interface RandomSource {
  /** Fill `out` with random bytes and return it. */
  (out: Uint8Array): Uint8Array;
}

/**
 * Widen a `Uint8Array` to the buffer type WebCrypto's declarations insist on.
 *
 * TypeScript 6 parameterises a typed array by the buffer behind it, and `BufferSource` excludes
 * `SharedArrayBuffer`. No array in this package ever sits on one — they are allocated here or
 * decoded from the wire — so the cast is sound, and it is the same one `@curlew/signal`'s
 * `crypto.ts` makes at its own boundary. Doing it once here keeps the rest of the package on the
 * plain `Uint8Array` every other module speaks.
 */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

/** The real one: `crypto.getRandomValues`. */
export const defaultRandomSource: RandomSource = (out) => crypto.getRandomValues(buf(out));

/** `length` random bytes from `random`. */
export function randomBytes(length: number, random: RandomSource = defaultRandomSource): Uint8Array {
  return random(new Uint8Array(length));
}

/** HMAC-SHA256 of `data` under `key`, all 32 bytes. */
export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const handle = await crypto.subtle.importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', handle, buf(data)));
}

/** SHA-256 of `data`. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf(data)));
}

/**
 * HKDF-SHA256 (extract-and-expand, RFC 5869) producing `length` bytes.
 *
 * Every caller in legacy OMEMO passes a 32-byte zero salt or a root key; none omits the salt, so
 * it is a required argument rather than defaulting to the empty string WebCrypto would want.
 */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  // Zero-length IKM is rejected by WebCrypto but never produced by this protocol; letting it
  // throw from importKey would name HKDF rather than the caller that built an empty secret.
  const handle = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) },
    handle,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** AES-256-CBC encrypt with PKCS#7 padding, as the ratchet's message layer uses it. */
export async function aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const handle = await crypto.subtle.importKey('raw', buf(key), 'AES-CBC', false, ['encrypt']);
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: buf(iv) }, handle, buf(plaintext)));
}

/**
 * AES-256-CBC decrypt, PKCS#7 checked.
 *
 * WebCrypto throws a bare `OperationError` on bad padding; it is translated here so a caller sees
 * this package's error type rather than a platform one whose message differs between GJS and Node.
 */
export async function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  const handle = await crypto.subtle.importKey('raw', buf(key), 'AES-CBC', false, ['decrypt']);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: buf(iv) }, handle, buf(ciphertext)));
  } catch (err) {
    throw new DecryptionFailedError(`AES-CBC decryption failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** AES-GCM encrypt with a 128-bit tag appended, as the payload cipher uses it. */
export async function aesGcmEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const handle = await crypto.subtle.importKey('raw', buf(key), 'AES-GCM', false, ['encrypt']);
  return new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), tagLength: 128 }, handle, buf(plaintext)),
  );
}

/** AES-GCM decrypt, expecting the 128-bit tag at the end of `ciphertext`. */
export async function aesGcmDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  const handle = await crypto.subtle.importKey('raw', buf(key), 'AES-GCM', false, ['decrypt']);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(iv), tagLength: 128 }, handle, buf(ciphertext)),
    );
  } catch (err) {
    throw new DecryptionFailedError(`AES-GCM decryption failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The DER prefix of a PKCS#8 X25519 private key: SEQUENCE { INTEGER 0, AlgorithmIdentifier
 * { 1.3.101.110 }, OCTET STRING { OCTET STRING (32) } }. The 32 raw scalar bytes follow.
 *
 * Fixed for every X25519 key, so it is a constant rather than something assembled per call.
 */
const PKCS8_X25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

/** X25519 ECDH: the 32-byte shared secret between our private scalar and their public key. */
export async function x25519(privateKey: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array> {
  assertLength('X25519 private key', privateKey, 32);
  assertLength('X25519 public key', publicKey, 32);
  const pkcs8 = new Uint8Array(PKCS8_X25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_X25519_PREFIX, 0);
  pkcs8.set(privateKey, PKCS8_X25519_PREFIX.length);
  const ours = await crypto.subtle.importKey('pkcs8', buf(pkcs8), 'X25519', false, ['deriveBits']);
  const theirs = await crypto.subtle.importKey('raw', buf(publicKey), 'X25519', false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: theirs }, ours, 256));
}

/**
 * The X25519 public key for a raw private scalar.
 *
 * WebCrypto will not derive one — `importKey('pkcs8', …)` yields a handle whose public half is
 * only reachable by generating the pair in the first place, which is no use for keys that came
 * out of storage or a fixture. The route is through Ed25519: `curveToEdPrivate` clamps the scalar
 * and gives the Ed25519 point, `edToCurvePublic` maps it back to Montgomery form. Both come from
 * `@gjsify/xeddsa`, the same code that signs the signed prekey, so there is exactly one curve
 * map in the dependency tree rather than a second hand-written one here.
 */
export function x25519PublicKey(privateKey: Uint8Array): Uint8Array {
  assertLength('X25519 private key', privateKey, 32);
  return edToCurvePublic(curveToEdPrivate(privateKey).publicKey);
}
