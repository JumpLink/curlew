/**
 * Blind trust before verification (ADR 0006 §6), as Conversations' `saveIdentity` implements it.
 *
 * The rule in one sentence: a key nobody has ever checked for this contact is trusted blindly,
 * but once ONE key of theirs has been verified by a human, every later key of theirs waits for a
 * human too. That is the whole point of BTBV — convenience until the person signals they care,
 * then no silent additions.
 *
 * Nothing here decides anything a person did not: `verified` and `distrusted` are only ever
 * written by the CLI, never by this module, and never by an agent (ADR 0006 §6 again — an MCP
 * tool that could verify a key would let a crafted message hand over the conversation).
 */

import {
  fingerprint,
  formatFingerprint,
  fromBase64,
  toBase64,
  type DeviceAddress,
  type IdentityRecord,
  type OmemoStorage,
  type TrustState,
} from '@curlew/omemo';

/** What {@link noteIdentity} found when it looked. */
export type IdentityOutcome =
  /** The device already had exactly this key. */
  | 'known'
  /** A device we had never seen a key for. */
  | 'new'
  /** A device whose key is not the one we had — never silent (ADR 0006 §6). */
  | 'replaced';

export interface NotedIdentity {
  readonly record: IdentityRecord;
  readonly outcome: IdentityOutcome;
}

/**
 * Record the identity key a message proved the sender holds, and decide its trust if it is new.
 *
 * Call it inside the ratchet transaction, with the key the key exchange carried or the one the
 * existing session authenticated against — never with a key straight off a fetched bundle,
 * which proves only that someone published it.
 */
export async function noteIdentity(
  storage: OmemoStorage,
  address: DeviceAddress,
  publicKey: Uint8Array,
  now: Date,
): Promise<NotedIdentity> {
  const encoded = toBase64(publicKey);
  const existing = await storage.loadIdentity(address);
  if (existing?.publicKey === encoded) return { record: existing, outcome: 'known' };

  const record: IdentityRecord = {
    publicKey: encoded,
    trust: (await hasVerifiedKey(storage, address.jid)) ? 'undecided' : 'blind',
    firstSeen: now.toISOString(),
  };
  await storage.saveIdentity(address, record);
  return { record, outcome: existing === undefined ? 'new' : 'replaced' };
}

/**
 * The same for a key straight off a fetched bundle, which is what the SEND path has.
 *
 * A published key proves only that someone put it on the server, so this one is stricter than
 * {@link noteIdentity} in exactly one place: a key that REPLACES one we already hold for that
 * device is not adopted — nothing is written, the stored record comes back unchanged, and the
 * outcome is `replaced`. The caller does not encrypt for it.
 *
 * Conversations would show the person an identity-change notice here and let them decide. Until
 * that notice exists, refusing the device is the safe half of the same behaviour: a peer who
 * genuinely reinstalled publishes a NEW device id, which arrives as `new` and is blindly
 * trusted like any other; a key swapped under an existing id is what an attacker in the
 * server's position would do.
 *
 * Still a transaction's business — call it inside one, so the record it reports is the record
 * the session is then built against.
 */
export async function noteBundleIdentity(
  storage: OmemoStorage,
  address: DeviceAddress,
  publicKey: Uint8Array,
  now: Date,
): Promise<NotedIdentity> {
  const encoded = toBase64(publicKey);
  const existing = await storage.loadIdentity(address);
  if (existing?.publicKey === encoded) return { record: existing, outcome: 'known' };
  if (existing !== undefined) return { record: existing, outcome: 'replaced' };
  return noteIdentity(storage, address, publicKey, now);
}

/** Whether any device of this JID carries a key a person has verified. */
export async function hasVerifiedKey(storage: OmemoStorage, jid: string): Promise<boolean> {
  for (const { record } of await storage.listIdentities(jid)) {
    if (record.trust === 'verified') return true;
  }
  return false;
}

/** One device as `curlew omemo devices` and the MCP tool show it. */
export interface DeviceSummary {
  readonly jid: string;
  readonly deviceId: number;
  /** 64 lowercase hex characters — the raw key, ungrouped. */
  readonly fingerprint: string;
  /** The same in 8 groups of 8, the form XEP-0384 §8 recommends for reading aloud. */
  readonly formatted: string;
  readonly trust: TrustState;
  readonly firstSeen: string;
  /** Whether a ratchet with this device exists. */
  readonly session: boolean;
  /** Whether this is the device curlew itself publishes. */
  readonly own: boolean;
}

/**
 * Every device of `jid` this account knows about.
 *
 * Built from what is STORED, not from the server's list: the question a reader has in front of
 * this output is "whose keys has my client been talking to", and a device that has published
 * itself but never sent anything has no key to show.
 */
export async function summarizeDevices(
  storage: OmemoStorage,
  jid: string,
  ownDeviceId?: number,
): Promise<DeviceSummary[]> {
  const sessions = new Set(
    (await storage.listSessionAddresses(jid)).map((address) => address.deviceId),
  );
  const out: DeviceSummary[] = [];
  for (const { address, record } of await storage.listIdentities(jid)) {
    const printed = print(record.publicKey);
    if (printed === undefined) continue;
    out.push({
      jid: address.jid,
      deviceId: address.deviceId,
      ...printed,
      trust: record.trust,
      firstSeen: record.firstSeen,
      session: sessions.has(address.deviceId),
      own: ownDeviceId !== undefined && address.deviceId === ownDeviceId,
    });
  }
  return out.sort((a, b) => a.deviceId - b.deviceId);
}

/**
 * Both forms of a stored key's fingerprint, or undefined when the row does not hold a key.
 *
 * Skipping such a row rather than throwing keeps `curlew omemo devices` usable on an account
 * whose file has one damaged identity: the other devices are exactly what the person opened the
 * command to see.
 */
function print(base64: string): { fingerprint: string; formatted: string } | undefined {
  try {
    const key = fromBase64(base64);
    return { fingerprint: fingerprint(key), formatted: formatFingerprint(key) };
  } catch {
    return undefined;
  }
}
