/**
 * Fingerprints: how an identity key is shown to a person so two people can compare them.
 *
 * In legacy OMEMO the fingerprint IS the identity key — 32 bytes of Curve25519, hex-encoded, no
 * hash in between. Conversations, Dino and Gajim all display those 64 hex characters in eight
 * groups of eight, and a verification QR code carries the same hex. There is deliberately no
 * digest step: a person comparing two screens has to be comparing the key the ratchet actually
 * authenticates, and a hash of it would be a second value to keep in sync.
 *
 * The leading `0x05` type byte is NOT part of the fingerprint, which is the easy mistake here —
 * including it shifts every displayed character and makes the fingerprint disagree with every
 * other client.
 */

import { fromHex, toHex } from './bytes.ts';
import { decodePublicKey, KEY_BYTES } from './keys.ts';

/** Characters per group in the displayed form. */
const GROUP_SIZE = 8;

/** The fingerprint of an identity key: 64 lowercase hex characters, no separators. */
export function fingerprint(identityKey: Uint8Array): string {
  return toHex(decodePublicKey(identityKey));
}

/**
 * The fingerprint grouped for reading aloud or comparing on screen.
 *
 * Eight groups of eight, space-separated by default — the layout Conversations uses, so two
 * people on different clients are comparing the same visual chunks.
 */
export function formatFingerprint(identityKey: Uint8Array, separator = ' '): string {
  const hex = fingerprint(identityKey);
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += GROUP_SIZE) groups.push(hex.slice(i, i + GROUP_SIZE));
  return groups.join(separator);
}

/**
 * Parse a fingerprint a person typed or scanned back into the raw identity key.
 *
 * Whitespace, colons and dashes are dropped and case is ignored: the input comes from a QR scan,
 * a paste out of another client, or someone retyping what they see, and each formats it its own
 * way. Returns `undefined` rather than throwing — a mistyped fingerprint is expected input, not a
 * programming error.
 */
export function parseFingerprint(text: string): Uint8Array | undefined {
  const hex = text.replace(/[\s:-]/g, '').toLowerCase();
  if (hex.length !== KEY_BYTES * 2 || !/^[0-9a-f]+$/.test(hex)) return undefined;
  return fromHex(hex);
}
