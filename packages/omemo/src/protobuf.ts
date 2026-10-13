/**
 * Just enough protobuf for the two legacy OMEMO structures.
 *
 * ADR 0006 §2 rules out protobufjs: `OMEMOMessage` and `OMEMOKeyExchange` have four and six
 * fields between them, all `uint32` or `bytes`, and a schema compiler plus its runtime would be
 * a dependency and a build step for ~100 lines of varints. Fields are emitted in ascending field
 * number, which is what every protobuf implementation does for a deterministic serialization and
 * what the fixtures recorded from python-oldmemo contain — the MAC is computed over these exact
 * bytes, so the order is part of the protocol here, not a formatting choice.
 *
 * Only wire types 0 (varint) and 2 (length-delimited) are produced. Unknown fields are kept
 * rather than rejected: a peer may send `registrationId` (field 5 of libsignal's
 * `PreKeySignalMessage`) or a field a later version adds, and a strict parser would make those
 * messages undecryptable for no gain.
 */

import { WireFormatError } from './errors.ts';

/** Wire type 0: a base-128 varint. */
export const WIRE_VARINT = 0;
/** Wire type 2: a length-prefixed byte string. */
export const WIRE_BYTES = 2;

/** One decoded field value. */
export type ProtobufValue =
  | { readonly wireType: typeof WIRE_VARINT; readonly value: number }
  | { readonly wireType: typeof WIRE_BYTES; readonly value: Uint8Array };

/** A decoded message: field number to the values seen for it, in order. */
export type ProtobufFields = ReadonlyMap<number, readonly ProtobufValue[]>;

/** Encode a varint. */
export function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`varint must be a non-negative integer, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`varint ${value} exceeds the safe integer range`);
  }
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return Uint8Array.from(out);
}

function encodeTag(field: number, wireType: number): Uint8Array {
  if (!Number.isInteger(field) || field < 1) {
    throw new RangeError(`field number must be a positive integer, got ${field}`);
  }
  return encodeVarint(field * 8 + wireType);
}

/** Encode one `uint32` field. */
export function encodeUint32Field(field: number, value: number): Uint8Array {
  const tag = encodeTag(field, WIRE_VARINT);
  const body = encodeVarint(value);
  const out = new Uint8Array(tag.length + body.length);
  out.set(tag, 0);
  out.set(body, tag.length);
  return out;
}

/** Encode one `bytes` field. */
export function encodeBytesField(field: number, value: Uint8Array): Uint8Array {
  const tag = encodeTag(field, WIRE_BYTES);
  const length = encodeVarint(value.length);
  const out = new Uint8Array(tag.length + length.length + value.length);
  out.set(tag, 0);
  out.set(length, tag.length);
  out.set(value, tag.length + length.length);
  return out;
}

/**
 * Decode a message into its fields.
 *
 * Throws {@link WireFormatError} for a truncated message, an unterminated varint, a varint too
 * large for an exact JavaScript integer, or a wire type this profile never uses — all of which
 * mean the bytes are not an OMEMO structure.
 */
export function decodeMessage(bytes: Uint8Array): ProtobufFields {
  const fields = new Map<number, ProtobufValue[]>();
  let offset = 0;

  const readVarint = (): number => {
    let value = 0;
    let shift = 1;
    for (;;) {
      if (offset >= bytes.length) throw new WireFormatError('protobuf: varint runs past the end');
      const byte = bytes[offset]!;
      offset++;
      value += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) break;
      shift *= 0x80;
      if (!Number.isSafeInteger(value) || shift > 2 ** 63) {
        throw new WireFormatError('protobuf: varint too large');
      }
    }
    if (!Number.isSafeInteger(value)) throw new WireFormatError('protobuf: varint too large');
    return value;
  };

  const push = (field: number, entry: ProtobufValue): void => {
    const existing = fields.get(field);
    if (existing) existing.push(entry);
    else fields.set(field, [entry]);
  };

  while (offset < bytes.length) {
    const tag = readVarint();
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (field === 0) throw new WireFormatError('protobuf: field number 0');

    if (wireType === WIRE_VARINT) {
      push(field, { wireType: WIRE_VARINT, value: readVarint() });
      continue;
    }
    if (wireType === WIRE_BYTES) {
      const length = readVarint();
      if (offset + length > bytes.length) {
        throw new WireFormatError('protobuf: length-delimited field runs past the end');
      }
      push(field, { wireType: WIRE_BYTES, value: bytes.subarray(offset, offset + length) });
      offset += length;
      continue;
    }
    throw new WireFormatError(`protobuf: unsupported wire type ${wireType} on field ${field}`);
  }

  return fields;
}

/** The last value of a `uint32` field, or `undefined` when it is absent. */
export function readUint32(fields: ProtobufFields, field: number): number | undefined {
  const values = fields.get(field);
  const last = values?.[values.length - 1];
  if (!last) return undefined;
  if (last.wireType !== WIRE_VARINT) {
    throw new WireFormatError(`protobuf: field ${field} is not a varint`);
  }
  return last.value;
}

/** The last value of a `bytes` field, or `undefined` when it is absent. */
export function readBytes(fields: ProtobufFields, field: number): Uint8Array | undefined {
  const values = fields.get(field);
  const last = values?.[values.length - 1];
  if (!last) return undefined;
  if (last.wireType !== WIRE_BYTES) {
    throw new WireFormatError(`protobuf: field ${field} is not length-delimited`);
  }
  return last.value;
}
