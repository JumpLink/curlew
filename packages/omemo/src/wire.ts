/**
 * The two structures that travel inside an `<encrypted>` element, and the one byte in front of
 * them.
 *
 * `OMEMOMessage` is libsignal's `SignalMessage` and `OMEMOKeyExchange` its `PreKeySignalMessage`,
 * both with the field numbers OMEMO froze. Which of the two a received blob is cannot be told
 * from the bytes — field 1 is length-delimited in both — so the caller says, from the stanza's
 * `prekey` attribute. That is why {@link decodeKeyExchange} and {@link decodeAuthenticatedMessage}
 * are separate entry points rather than one sniffing function.
 *
 * The version byte (`0x33`, i.e. major 3 / minor 3) prefixes BOTH structures, and for the message
 * it is inside the MAC input, so it cannot be stripped early and re-added later.
 */

import { concatBytes } from './bytes.ts';
import { WireFormatError } from './errors.ts';
import { decodePublicKey, encodePublicKey } from './keys.ts';
import { LEGACY_PROFILE, type OmemoProfile } from './profile.ts';
import {
  decodeMessage,
  encodeBytesField,
  encodeUint32Field,
  readBytes,
  readUint32,
  type ProtobufFields,
} from './protobuf.ts';

/** Field numbers of `OMEMOMessage`. */
const MESSAGE_DH_PUB = 1;
const MESSAGE_N = 2;
const MESSAGE_PN = 3;
const MESSAGE_CIPHERTEXT = 4;

/**
 * Field numbers of `OMEMOKeyExchange`.
 *
 * Field 5 is libsignal's `registrationId`. python-oldmemo does not emit it and OMEMO has no use
 * for it, so neither do we — but it is accepted on the way in, since Conversations sends it.
 */
const EXCHANGE_PK_ID = 1;
const EXCHANGE_EK = 2;
const EXCHANGE_IK = 3;
const EXCHANGE_MESSAGE = 4;
const EXCHANGE_SPK_ID = 6;

/** The header and ciphertext of one ratchet message. */
export interface OmemoMessage {
  /** The sender's current ratchet public key, raw (no `0x05` prefix). */
  readonly ratchetPublicKey: Uint8Array;
  /** `n`: this message's index in the sender's current sending chain. */
  readonly counter: number;
  /** `pn`: how long the sender's previous sending chain was. */
  readonly previousCounter: number;
  /** The AES-CBC ciphertext of the 32 key bytes this message carries. */
  readonly ciphertext: Uint8Array;
}

/** A key exchange, carrying a ratchet message inside it. */
export interface OmemoKeyExchange {
  /** Which of the recipient's prekeys was consumed. */
  readonly preKeyId: number;
  /** Which of the recipient's signed prekeys the exchange used. */
  readonly signedPreKeyId: number;
  /** The sender's ephemeral (base) public key, raw. */
  readonly ephemeralKey: Uint8Array;
  /** The sender's identity public key, raw. */
  readonly identityKey: Uint8Array;
  /** The serialized `OMEMOAuthenticatedMessage` this exchange delivers. */
  readonly message: Uint8Array;
}

/**
 * Serialize `OMEMOMessage` with the leading version byte, optionally without the ciphertext.
 *
 * `withoutCiphertext` is the associated-data form: `_build_associated_data` in python-oldmemo
 * appends exactly fields 1-3 to the two identity keys, and the AEAD authenticates that. Note it
 * carries NO version byte there, while the MAC's second half does — hence the separate flag
 * rather than two near-identical functions.
 */
export function encodeMessageFields(message: OmemoMessage, withoutCiphertext = false): Uint8Array {
  const parts = [
    encodeBytesField(MESSAGE_DH_PUB, encodePublicKey(message.ratchetPublicKey)),
    encodeUint32Field(MESSAGE_N, message.counter),
    encodeUint32Field(MESSAGE_PN, message.previousCounter),
  ];
  if (!withoutCiphertext) parts.push(encodeBytesField(MESSAGE_CIPHERTEXT, message.ciphertext));
  return concatBytes(...parts);
}

/** `0x33 || OMEMOMessage` — the bytes the MAC is computed over and that precede it on the wire. */
export function encodeMessage(message: OmemoMessage, profile: OmemoProfile = LEGACY_PROFILE): Uint8Array {
  return concatBytes(Uint8Array.of(profile.versionByte), encodeMessageFields(message));
}

function requireBytes(fields: ProtobufFields, field: number, name: string): Uint8Array {
  const value = readBytes(fields, field);
  if (value === undefined) throw new WireFormatError(`${name} is missing`);
  return value;
}

/** Parse an `OMEMOMessage` body — the bytes AFTER the version byte. */
export function decodeMessageFields(bytes: Uint8Array): OmemoMessage {
  const fields = decodeMessage(bytes);
  return {
    ratchetPublicKey: decodePublicKey(requireBytes(fields, MESSAGE_DH_PUB, 'OMEMOMessage.dh_pub')),
    // Absent is zero in proto2/proto3 alike, and a first message legitimately has n = pn = 0,
    // which protobuf's deterministic encoder may omit entirely.
    counter: readUint32(fields, MESSAGE_N) ?? 0,
    previousCounter: readUint32(fields, MESSAGE_PN) ?? 0,
    ciphertext: requireBytes(fields, MESSAGE_CIPHERTEXT, 'OMEMOMessage.ciphertext'),
  };
}

/**
 * Split a serialized `OMEMOAuthenticatedMessage` into the MAC input and the MAC.
 *
 * The structure is plain concatenation in the legacy version — `message || mac8`, no protobuf
 * wrapper (python-oldmemo fakes the protobuf API with a `NamedTuple` for exactly this reason). The
 * first slice is returned verbatim, version byte included, because the MAC covers those bytes and
 * re-encoding a parsed message is not guaranteed to reproduce them.
 */
export function splitAuthenticatedMessage(
  bytes: Uint8Array,
  profile: OmemoProfile = LEGACY_PROFILE,
): { readonly macInput: Uint8Array; readonly mac: Uint8Array; readonly message: OmemoMessage } {
  if (bytes.length <= profile.macLength + 1) {
    throw new WireFormatError(`OMEMOAuthenticatedMessage is ${bytes.length} bytes, too short to hold a MAC`);
  }
  const split = bytes.length - profile.macLength;
  const macInput = bytes.subarray(0, split);
  if (macInput[0] !== profile.versionByte) {
    throw new WireFormatError(
      `OMEMOMessage version byte is 0x${macInput[0]!.toString(16)}, expected 0x${profile.versionByte.toString(16)}`,
    );
  }
  return {
    macInput,
    mac: bytes.subarray(split),
    message: decodeMessageFields(macInput.subarray(1)),
  };
}

/** `0x33 || OMEMOMessage || mac` — a complete `OMEMOAuthenticatedMessage`. */
export function encodeAuthenticatedMessage(
  message: OmemoMessage,
  mac: Uint8Array,
  profile: OmemoProfile = LEGACY_PROFILE,
): Uint8Array {
  return concatBytes(encodeMessage(message, profile), mac);
}

/**
 * Serialize `OMEMOKeyExchange` with its version byte.
 *
 * Fields go out in ascending field number, which puts `spk_id` (6) last even though it reads as
 * part of the header — the same order protobuf's deterministic serializer produces and the
 * fixtures contain.
 */
export function encodeKeyExchange(
  exchange: OmemoKeyExchange,
  profile: OmemoProfile = LEGACY_PROFILE,
): Uint8Array {
  return concatBytes(
    Uint8Array.of(profile.versionByte),
    encodeUint32Field(EXCHANGE_PK_ID, exchange.preKeyId),
    encodeBytesField(EXCHANGE_EK, encodePublicKey(exchange.ephemeralKey)),
    encodeBytesField(EXCHANGE_IK, encodePublicKey(exchange.identityKey)),
    encodeBytesField(EXCHANGE_MESSAGE, exchange.message),
    encodeUint32Field(EXCHANGE_SPK_ID, exchange.signedPreKeyId),
  );
}

/** Parse a serialized `OMEMOKeyExchange`, version byte included. */
export function decodeKeyExchange(
  bytes: Uint8Array,
  profile: OmemoProfile = LEGACY_PROFILE,
): OmemoKeyExchange {
  if (bytes.length < 1) throw new WireFormatError('OMEMOKeyExchange is empty');
  if (bytes[0] !== profile.versionByte) {
    throw new WireFormatError(
      `OMEMOKeyExchange version byte is 0x${bytes[0]!.toString(16)}, expected 0x${profile.versionByte.toString(16)}`,
    );
  }
  const fields = decodeMessage(bytes.subarray(1));
  const preKeyId = readUint32(fields, EXCHANGE_PK_ID);
  const signedPreKeyId = readUint32(fields, EXCHANGE_SPK_ID);
  if (preKeyId === undefined) throw new WireFormatError('OMEMOKeyExchange.pk_id is missing');
  if (signedPreKeyId === undefined) throw new WireFormatError('OMEMOKeyExchange.spk_id is missing');
  return {
    preKeyId,
    signedPreKeyId,
    ephemeralKey: decodePublicKey(requireBytes(fields, EXCHANGE_EK, 'OMEMOKeyExchange.ek')),
    identityKey: decodePublicKey(requireBytes(fields, EXCHANGE_IK, 'OMEMOKeyExchange.ik')),
    message: requireBytes(fields, EXCHANGE_MESSAGE, 'OMEMOKeyExchange.message'),
  };
}
