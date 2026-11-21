/**
 * Encrypted attachments: the `EncryptedFile` of the client-server spec (§ sending encrypted
 * attachments), which is how a file in an encrypted room stays unreadable to the homeserver.
 *
 * The media repository is NOT encrypted — anyone who learns an `mxc://` URI can download the
 * bytes. So the file is encrypted here, before the upload, with a key that exists only inside the
 * (encrypted) event that points at it: AES-CTR-256, a SHA-256 of the CIPHERTEXT, and a JWK that
 * rides along in `content.file`. Decrypting is the same in reverse, and the hash is checked
 * first: the ciphertext comes from a server that could have replaced it.
 *
 * matrix-js-sdk ships no such helper in the build curlew uses (it lives in matrix-react-sdk), so
 * this is ours — on WebCrypto only, which both runtimes have (`@gjsify/webcrypto` on GJS),
 * exactly as `@curlew/omemo` does it. No `gi://`, no Node built-in: unit-testable on both.
 */

import { _ } from '@curlew/protocol';

/**
 * The `file` object of an encrypted attachment, as it rides in the event content in place of
 * `url` (and in `info.thumbnail_file` for a thumbnail).
 */
export interface EncryptedFile {
  /** The `mxc://` URI of the CIPHERTEXT in the media repository. */
  url: string;
  /** The per-file key as a JWK: `A256CTR`, extractable, `key_ops: ['encrypt','decrypt']`. */
  key: {
    kty: 'oct';
    key_ops: readonly string[];
    alg: 'A256CTR';
    k: string;
    ext: true;
  };
  /** The AES-CTR initialisation vector, unpadded base64 of 16 bytes. */
  iv: string;
  /** `sha256`: unpadded base64 of the SHA-256 of the ciphertext. */
  hashes: Readonly<Record<string, string>>;
  /** The version of this format; `v2` is what every current client writes and reads. */
  v: string;
}

/** The ciphertext to upload, and the `file` object the event must carry to point at it. */
export interface EncryptedAttachment {
  ciphertext: Uint8Array;
  /** Everything but `url`, which only the upload knows. */
  file: Omit<EncryptedFile, 'url'>;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Unpadded standard base64, which is what the spec's `hashes`/`iv` fields hold. */
export function toUnpaddedBase64(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += BASE64[a >> 2];
    out += BASE64[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += BASE64[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += BASE64[c & 0x3f];
  }
  return out;
}

/** base64 or base64url, padded or not — a key from another client may be any of them. */
export function fromBase64(text: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    if (ch === '=') break;
    const value = BASE64.indexOf(ch === '-' ? '+' : ch === '_' ? '/' : ch);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/**
 * The counter block: 16 bytes of which only the TOP 64 bits are random, the low 64 starting at
 * zero. The spec requires it, and the reason is that AES-CTR counts up per 16-byte block: with a
 * random low half, a long file would run the counter past the next IV's starting point and
 * encrypt two blocks under the same keystream.
 */
function counterBlock(random: Uint8Array): Uint8Array {
  const iv = new Uint8Array(16);
  iv.set(random.subarray(0, 8), 0);
  return iv;
}

const CRYPTO = (): Crypto => {
  const available = globalThis.crypto;
  if (!available?.subtle) {
    throw new Error(_('this runtime has no WebCrypto — an encrypted attachment cannot be prepared'));
  }
  return available;
};

/** Encrypt one file's bytes for an encrypted room. The key is returned, never stored here. */
export async function encryptAttachment(plaintext: Uint8Array): Promise<EncryptedAttachment> {
  const crypto = CRYPTO();
  const iv = counterBlock(crypto.getRandomValues(new Uint8Array(8)));
  const key = await crypto.subtle.generateKey({ name: 'AES-CTR', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: iv as Uint8Array<ArrayBuffer>, length: 64 },
    key,
    plaintext as Uint8Array<ArrayBuffer>,
  );
  const ciphertext = new Uint8Array(encrypted);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encrypted));
  const jwk = (await crypto.subtle.exportKey('jwk', key)) as { k?: unknown };
  if (typeof jwk.k !== 'string') throw new Error(_('WebCrypto exported no key material for the attachment'));
  return {
    ciphertext,
    file: {
      key: { kty: 'oct', key_ops: ['encrypt', 'decrypt'], alg: 'A256CTR', k: jwk.k, ext: true },
      iv: toUnpaddedBase64(iv),
      hashes: { sha256: toUnpaddedBase64(digest) },
      v: 'v2',
    },
  };
}

/** The `file` object of an event's content, or null when it carries none that can be used. */
export function parseEncryptedFile(value: unknown): EncryptedFile | null {
  if (typeof value !== 'object' || value === null) return null;
  const file = value as Record<string, unknown>;
  const key = file.key as Record<string, unknown> | undefined;
  const hashes = file.hashes as Record<string, unknown> | undefined;
  if (typeof file.url !== 'string' || !file.url.startsWith('mxc://')) return null;
  if (typeof file.iv !== 'string' || typeof key?.k !== 'string') return null;
  if (typeof hashes?.sha256 !== 'string') return null;
  return {
    url: file.url,
    key: { kty: 'oct', key_ops: ['encrypt', 'decrypt'], alg: 'A256CTR', k: key.k, ext: true },
    iv: file.iv,
    hashes: { sha256: hashes.sha256 },
    v: typeof file.v === 'string' ? file.v : 'v2',
  };
}

/**
 * Decrypt downloaded bytes, after checking the hash the sender put in the event.
 *
 * The hash is the whole point of the check: the key came through the encrypted event, the bytes
 * came from the homeserver, and only the hash binds the two. A mismatch means the media was
 * replaced, so it is an error and not a decryption attempt.
 */
export async function decryptAttachment(ciphertext: Uint8Array, file: EncryptedFile): Promise<Uint8Array> {
  const crypto = CRYPTO();
  const expected = file.hashes.sha256;
  if (typeof expected !== 'string' || expected.length === 0) {
    throw new Error(_('the encrypted attachment carries no SHA-256 — it cannot be verified'));
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', ciphertext as Uint8Array<ArrayBuffer>),
  );
  if (toUnpaddedBase64(digest) !== expected.replace(/=+$/, '')) {
    throw new Error(_('the downloaded media does not match the hash in the event — it was not decrypted'));
  }
  const iv = fromBase64(file.iv);
  if (iv.length !== 16) throw new Error(_('the encrypted attachment has no 16-byte counter block'));
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'oct', k: file.key.k, alg: 'A256CTR', ext: true, key_ops: ['encrypt', 'decrypt'] },
    { name: 'AES-CTR', length: 256 },
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: iv as Uint8Array<ArrayBuffer>, length: 64 },
    key,
    ciphertext as Uint8Array<ArrayBuffer>,
  );
  return new Uint8Array(plaintext);
}
