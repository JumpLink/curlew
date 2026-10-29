/**
 * Blind trust before verification (ADR 0006 §6), as Conversations' `saveIdentity` implements it.
 *
 * The rule in one sentence: a key nobody has ever checked for this contact is trusted blindly,
 * but once ONE key of theirs has been verified by a human, every later key of theirs waits for a
 * human too. That is the whole point of BTBV — convenience until the person signals they care,
 * then no silent additions.
 *
 * Nothing here decides anything a person did not. {@link noteIdentity} hands out `blind` and
 * `undecided` and nothing else; `verified` and `distrusted` are written in exactly one place,
 * {@link setTrustByFingerprint}, which is reachable only from `curlew omemo trust` and never
 * from an agent (ADR 0006 §6 again — an MCP tool that could verify a key would let a crafted
 * message hand over the conversation).
 */

import {
  addressKey,
  fingerprint,
  formatFingerprint,
  fromBase64,
  parseFingerprint,
  toBase64,
  type DeviceAddress,
  type IdentityRecord,
  type OmemoStorage,
  type TrustState,
} from '@curlew/omemo';

/**
 * A key published under a device id we already hold a key for, kept until a person decides.
 *
 * It has to be STORED, which is the one thing that is not obvious here: a fingerprint is the key
 * itself in legacy OMEMO, but `curlew omemo trust` is given eight groups of hex, and adopting a
 * key means writing bytes. Keeping the pending key is what lets the person's decision land on
 * the key they compared rather than on the one we already distrust.
 */
export interface IdentityChange {
  /** The newly published key, base64 as {@link IdentityRecord.publicKey} spells it. */
  readonly publicKey: string;
  /** When the change was first seen, ISO-8601. */
  readonly seenAt: string;
}

/**
 * The writes a trust decision needs and {@link OmemoStorage} has no reason to declare.
 *
 * `IdentityRecord` is `{ publicKey, trust, firstSeen }` — one key per device, with no slot for a
 * second one waiting to be judged — and `@curlew/omemo` is right not to have one: a pending
 * change is a thing to SHOW someone, which is curlew's half of ADR 0006, not the ratchet's.
 *
 * Every method is optional on {@link TrustStorage}, so a plain `OmemoStorage` still goes through
 * the functions below: it then records no pending change, which is exactly stage 3's behaviour.
 */
export interface OmemoTrustStore {
  loadIdentityChange(address: DeviceAddress): Promise<IdentityChange | undefined>;
  saveIdentityChange(address: DeviceAddress, entry: IdentityChange): Promise<void>;
  deleteIdentityChange(address: DeviceAddress): Promise<void>;
  /** Every pending change, optionally of one JID only. */
  listIdentityChanges(jid?: string): Promise<{ address: DeviceAddress; entry: IdentityChange }[]>;
  /** Forget a JID's cached device list, so the next send asks the server. */
  deleteDeviceList(jid: string): Promise<void>;
}

/** An {@link OmemoStorage} that may also be able to hold a pending change. */
export type TrustStorage = OmemoStorage & Partial<OmemoTrustStore>;

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
  storage: TrustStorage,
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
  // The stored key is now the newest one we know of, so anything the SEND path parked for this
  // device is answered: either it was this key, or it is older than what a message just proved.
  await storage.deleteIdentityChange?.(address);
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
 * The device is refused, and the key is PARKED as an {@link IdentityChange} for the person to
 * decide about: `curlew omemo devices` then shows both fingerprints and `curlew omemo trust`
 * can adopt the new one. A peer who genuinely reinstalled publishes a NEW device id, which
 * arrives as `new` and is blindly trusted like any other; a key swapped under an existing id is
 * what an attacker in the server's position would do, which is why it waits for a human.
 *
 * Still a transaction's business — call it inside one, so the record it reports is the record
 * the session is then built against.
 */
export async function noteBundleIdentity(
  storage: TrustStorage,
  address: DeviceAddress,
  publicKey: Uint8Array,
  now: Date,
): Promise<NotedIdentity> {
  const encoded = toBase64(publicKey);
  const existing = await storage.loadIdentity(address);
  if (existing?.publicKey === encoded) return { record: existing, outcome: 'known' };
  if (existing !== undefined) {
    // `seenAt` is not refreshed on every later send: the question a reader has is since when the
    // key changed, and overwriting it with today's date would answer "just now" for ever.
    const parked = await storage.loadIdentityChange?.(address);
    if (parked?.publicKey !== encoded) {
      await storage.saveIdentityChange?.(address, { publicKey: encoded, seenAt: now.toISOString() });
    }
    return { record: existing, outcome: 'replaced' };
  }
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
  /**
   * A key this device has published SINCE, which no person has decided about yet (§6).
   *
   * Both fingerprints are shown on purpose: the one above is what curlew still encrypts to under
   * the trust beside it, and this one is what the peer's client now offers. Which of the two the
   * person compared out of band is the whole decision `curlew omemo trust` takes.
   */
  readonly changed?: { fingerprint: string; formatted: string; seenAt: string };
}

/**
 * Every device of `jid` this account knows about.
 *
 * Built from what is STORED, not from the server's list: the question a reader has in front of
 * this output is "whose keys has my client been talking to", and a device that has published
 * itself but never sent anything has no key to show.
 */
export async function summarizeDevices(
  storage: TrustStorage,
  jid: string,
  ownDeviceId?: number,
): Promise<DeviceSummary[]> {
  const sessions = new Set(
    (await storage.listSessionAddresses(jid)).map((address) => address.deviceId),
  );
  const changes = new Map(
    ((await storage.listIdentityChanges?.(jid)) ?? []).map(({ address, entry }) => [
      addressKey(address),
      entry,
    ]),
  );
  const out: DeviceSummary[] = [];
  for (const { address, record } of await storage.listIdentities(jid)) {
    const printed = print(record.publicKey);
    if (printed === undefined) continue;
    const change = changes.get(addressKey(address));
    const changedPrint = change === undefined ? undefined : print(change.publicKey);
    out.push({
      jid: address.jid,
      deviceId: address.deviceId,
      ...printed,
      trust: record.trust,
      firstSeen: record.firstSeen,
      session: sessions.has(address.deviceId),
      own: ownDeviceId !== undefined && address.deviceId === ownDeviceId,
      ...(change === undefined || changedPrint === undefined
        ? {}
        : { changed: { ...changedPrint, seenAt: change.seenAt } }),
    });
  }
  return out.sort((a, b) => a.deviceId - b.deviceId);
}

/** The two states a person may put a device in. `undecided` and `blind` are BTBV's to hand out. */
export type TrustDecision = 'verified' | 'distrusted';

/**
 * What {@link setTrustByFingerprint} did, or why it did nothing.
 *
 * A result rather than a throw for the three ways the input can be wrong, because all three are
 * expected input: someone retyping 64 hex characters mistypes them, and someone comparing a
 * fingerprint over the phone reads out the wrong contact's. The sentence a person reads is the
 * frontend's to choose (`MESSAGES.omemoTrust`), which is also where it can be translated.
 */
export type TrustResult =
  | {
      readonly kind: 'set';
      readonly address: DeviceAddress;
      readonly trust: TrustDecision;
      readonly fingerprint: string;
      readonly formatted: string;
      /** The decision adopted a key that had REPLACED the one stored for this device. */
      readonly adopted: boolean;
      /** The ratchet dropped with it — only ever on an adoption. */
      readonly sessionDropped: boolean;
    }
  | { readonly kind: 'unparsable' }
  | { readonly kind: 'unknown' }
  /** Two devices of this JID carry that key, so the fingerprint does not name one. */
  | { readonly kind: 'ambiguous'; readonly count: number };

/**
 * Put the device whose key a person compared into `verified` or `distrusted` (ADR 0006 §6).
 *
 * Addressed by FINGERPRINT, not by device id, because the fingerprint is what the person has in
 * front of them from the second channel — a device id matched against the wrong row would mark
 * the wrong key verified, and a verified key is the one thing BTBV never revisits.
 *
 * A fingerprint that names a PARKED key ({@link noteBundleIdentity}) adopts it: it becomes the
 * key stored for that device, with the decided trust, and the pending entry goes. The ratchet
 * goes with it — it was built against the key we no longer hold, and a peer who published a new
 * key under the same device id has no session left either, so the next message is a key
 * exchange. Trust decisions about the JID's OTHER devices are untouched, here as everywhere:
 * BTBV decides a key, never a contact.
 *
 * Takes its own transaction, so reading the candidates and writing the decision cannot be
 * interleaved with the daemon noting a third key for the same device.
 */
export async function setTrustByFingerprint(
  storage: TrustStorage,
  jid: string,
  typed: string,
  decision: TrustDecision,
  now: Date = new Date(),
): Promise<TrustResult> {
  const key = parseFingerprint(typed);
  if (key === undefined) return { kind: 'unparsable' };
  const wanted = toBase64(key);

  return storage.transaction(async () => {
    const stored = await storage.listIdentities(jid);
    const parked = (await storage.listIdentityChanges?.(jid)) ?? [];
    // A parked key never equals the stored key of its own device — `noteBundleIdentity` parks
    // only a key that differs — so the two lists cannot both match for one address.
    const candidates = [
      ...stored
        .filter(({ record }) => record.publicKey === wanted)
        .map(({ address, record }) => ({ address, firstSeen: record.firstSeen, adopted: false })),
      ...parked
        .filter(({ entry }) => entry.publicKey === wanted)
        .map(({ address }) => ({ address, firstSeen: now.toISOString(), adopted: true })),
    ];
    if (candidates.length === 0) return { kind: 'unknown' };
    if (candidates.length > 1) return { kind: 'ambiguous', count: candidates.length };

    const [{ address, firstSeen, adopted }] = candidates;
    await storage.saveIdentity(address, { publicKey: wanted, trust: decision, firstSeen });
    let sessionDropped = false;
    if (adopted) {
      sessionDropped = (await storage.loadSession(address)) !== undefined;
      if (sessionDropped) await storage.deleteSession(address);
      await storage.deleteIdentityChange?.(address);
    }
    return {
      kind: 'set',
      address,
      trust: decision,
      fingerprint: fingerprint(key),
      formatted: formatFingerprint(key),
      adopted,
      sessionDropped,
    };
  });
}

/** What {@link resetSessions} threw away. */
export interface ResetResult {
  /** The device addresses whose ratchet is gone, by id. */
  readonly deviceIds: number[];
  /** Whether a cached device list was dropped with them. */
  readonly deviceList: boolean;
}

/**
 * Throw away every ratchet with `jid`, so the next message starts a fresh session.
 *
 * XEP-0384 §6 makes a manual reset a MUST: a ratchet can end up in a state neither side can
 * step out of (a message that never arrived, a store restored from a backup), and no amount of
 * retrying repairs it — only a new key exchange does.
 *
 * Identities and their trust SURVIVE. A stuck ratchet says nothing about whose key it was built
 * against, and a reset that forgot a verified fingerprint would quietly ask the person to compare
 * it again — which is the one moment an attacker would want. Changing a trust decision is
 * {@link setTrustByFingerprint}'s job and needs the fingerprint typed back.
 *
 * The cached device list goes too, because the other reason a session cannot be rebuilt is a
 * list that names devices the peer no longer has.
 */
export async function resetSessions(storage: TrustStorage, jid: string): Promise<ResetResult> {
  return storage.transaction(async () => {
    const sessions = await storage.listSessionAddresses(jid);
    for (const address of sessions) await storage.deleteSession(address);
    const deviceList =
      storage.deleteDeviceList !== undefined && (await storage.loadDeviceList(jid)) !== undefined;
    if (deviceList) await storage.deleteDeviceList?.(jid);
    return { deviceIds: sessions.map((address) => address.deviceId), deviceList };
  });
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
