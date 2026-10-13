/**
 * Byte helpers. Nothing OMEMO-specific lives here, but everything else in the package needs
 * them, and they must behave identically on GJS and Node — so only `btoa`/`atob`,
 * `TextEncoder` and plain arithmetic, no `Buffer`, no `gi://`.
 */

/** Join byte arrays into one. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Compare two byte arrays without an early exit.
 *
 * Every comparison in this package runs over a MAC, a key or a fingerprint, so the timing of a
 * mismatch must not say where the first differing byte sits. Length is not a secret — it is
 * fixed by the protocol — so it is checked first.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Base64 (padded) for a byte array. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: String.fromCharCode(...bytes) blows the call stack on a long array.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** The bytes of a base64 string. Throws on anything that is not base64. */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Lowercase hex for a byte array. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** The bytes of a hex string, either case. Throws on an odd length or a non-hex digit. */
export function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0) throw new RangeError('hex string has an odd length');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new RangeError(`not a hex string: ${text}`);
    out[i] = byte;
  }
  return out;
}

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 bytes of a string. */
export function utf8ToBytes(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text);
}

/** A string from UTF-8 bytes. Throws when the bytes are not valid UTF-8. */
export function bytesToUtf8(bytes: Uint8Array): string {
  return UTF8_DECODER.decode(bytes);
}

/** Throw unless `bytes` is a `Uint8Array` of exactly `length` bytes. */
export function assertLength(name: string, bytes: Uint8Array, length: number): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new TypeError(`${name} must be a Uint8Array of ${length} bytes`);
  }
}
