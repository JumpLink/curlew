/**
 * The protocol version as one value, so the logic around it does not have to know which one it
 * is running.
 *
 * ADR 0006 §1: curlew speaks `eu.siacs.conversations.axolotl` and nothing else today, but
 * `urn:xmpp:omemo:2` differs in exactly the places collected here — namespace, wire format
 * version byte, identity key encoding, payload cipher, KDF info strings. Keeping them in one
 * record is what lets the ratchet, the sessions and the stores stay shared when the `v2` profile
 * arrives, instead of growing a second copy of each.
 *
 * Only {@link LEGACY_PROFILE} exists for now. A `v2` profile is a separate ADR.
 */

import { utf8ToBytes } from './bytes.ts';

/** Which OMEMO version a profile describes. */
export type OmemoVersion = 'legacy' | 'v2';

/** Everything that differs between OMEMO versions. */
export interface OmemoProfile {
  /** Which version this is. */
  readonly version: OmemoVersion;
  /** The XML namespace of the stanza elements and the PEP nodes. */
  readonly namespace: string;
  /** The leading byte of every serialized message and key exchange. */
  readonly versionByte: number;
  /** HKDF info for the X3DH shared secret. */
  readonly x3dhInfo: Uint8Array;
  /** HKDF info for a root-chain step. */
  readonly rootChainInfo: Uint8Array;
  /** HKDF info for the message keys derived from a chain key. */
  readonly messageKeysInfo: Uint8Array;
  /** How many bytes of the HMAC travel with a ratchet message. */
  readonly macLength: number;
  /** Length of the payload cipher's key — 16 for AES-128-GCM, the legacy payload cipher. */
  readonly payloadKeyLength: number;
  /** Length of the IV this version generates. Received messages may carry another length. */
  readonly payloadIvLength: number;
  /** Length of the payload cipher's authentication tag. */
  readonly payloadTagLength: number;
  /** How many prekeys the bundle publishes (XEP-0384 4.2; Conversations' `NUM_KEYS_TO_PUBLISH`). */
  readonly preKeyCount: number;
  /** Below this many unused prekeys the bundle is topped up again. */
  readonly preKeyRefillThreshold: number;
}

/**
 * OMEMO 0.3.0, namespace `eu.siacs.conversations.axolotl` — what Conversations, Dino, Gajim and
 * Monal send today.
 *
 * The three info strings are libsignal's and are what make this wire-compatible: `WhisperText`
 * for the X3DH output (`RatchetingSession`), `WhisperRatchet` for a root-chain step (`RootKey`),
 * `WhisperMessageKeys` for the per-message keys (`ChainKey`). The 8-byte MAC is
 * `SignalMessage.MAC_LENGTH`.
 */
export const LEGACY_PROFILE: OmemoProfile = {
  version: 'legacy',
  namespace: 'eu.siacs.conversations.axolotl',
  versionByte: 0x33,
  x3dhInfo: utf8ToBytes('WhisperText'),
  rootChainInfo: utf8ToBytes('WhisperRatchet'),
  messageKeysInfo: utf8ToBytes('WhisperMessageKeys'),
  macLength: 8,
  payloadKeyLength: 16,
  payloadIvLength: 12,
  payloadTagLength: 16,
  preKeyCount: 100,
  preKeyRefillThreshold: 75,
};

/** The namespace of OMEMO 2, recognised only to mark a message `undecryptable: v2` (ADR §1). */
export const OMEMO_2_NAMESPACE = 'urn:xmpp:omemo:2';
