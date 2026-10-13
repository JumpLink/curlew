/**
 * The handful of types every other module here agrees on: who a device is, and how much it is
 * trusted.
 *
 * Deliberately small. The trust STATES live here because the storage port records one per
 * identity, but the trust DECISION — blind trust before verification, and who may change it —
 * is ADR 0006 §6 and belongs to the stage that owns a user interface for it.
 */

/**
 * An OMEMO device id: a positive 31-bit integer the device picks for itself.
 *
 * Randomly chosen rather than counted up (ADR 0006 §3), so two of the person's devices that
 * publish at the same moment do not collide on `1`.
 */
export type DeviceId = number;

/** The largest valid device id: ids are `1 … 2³¹ − 1`. */
export const MAX_DEVICE_ID = 2 ** 31 - 1;

/** One device of one account — what a session, an identity and a trust decision are keyed by. */
export interface DeviceAddress {
  /** The bare JID, no resource. */
  readonly jid: string;
  /** The device id within that JID. */
  readonly deviceId: DeviceId;
}

/**
 * How much a device's identity key is trusted (ADR 0006 §6).
 *
 * `blind` is a real state, not a synonym for `undecided`: it means trusted without anyone having
 * compared a fingerprint, which is enough to send, while `undecided` is not. Keeping them apart
 * is what lets a reader see whether a received message was authenticated against a key a human
 * ever checked.
 */
export type TrustState = 'undecided' | 'blind' | 'verified' | 'distrusted';

/** Whether a message may be encrypted for a device in this trust state. */
export function mayEncryptTo(trust: TrustState): boolean {
  return trust === 'blind' || trust === 'verified';
}

/** `<jid>:<device id>` — the key an address is stored under. */
export function addressKey(address: DeviceAddress): string {
  return `${address.jid}:${address.deviceId}`;
}

/**
 * Parse an {@link addressKey} back into an address.
 *
 * The device id is split off at the LAST colon, because a JID may contain colons in its local
 * part and splitting at the first would mangle those.
 */
export function parseAddressKey(key: string): DeviceAddress | undefined {
  const split = key.lastIndexOf(':');
  if (split <= 0) return undefined;
  const deviceId = Number(key.slice(split + 1));
  if (!Number.isInteger(deviceId) || deviceId < 1 || deviceId > MAX_DEVICE_ID) return undefined;
  return { jid: key.slice(0, split), deviceId };
}

/** Whether two addresses name the same device. */
export function sameAddress(a: DeviceAddress, b: DeviceAddress): boolean {
  return a.jid === b.jid && a.deviceId === b.deviceId;
}
