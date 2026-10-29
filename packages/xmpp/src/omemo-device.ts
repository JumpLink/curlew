/**
 * Our own OMEMO device: the keys it publishes, and when they are renewed.
 *
 * Everything here is storage plus arithmetic — no stanza, no socket. The caller publishes what
 * {@link ensureBundle} hands back, which is what keeps the "may we even publish?" question
 * (the `xmpp.omemo` grant, ADR 0006 §5) out of this module and in the one that holds the link.
 *
 * Both entry points run inside a storage transaction, because both are read-decide-write: two
 * processes that each see "no device yet" would otherwise register two devices on one account,
 * and two that each see "fewer than 75 prekeys" would hand out the same ids twice.
 */

import {
  buildBundle,
  defaultRandomSource,
  fromBase64,
  generateKeyPair,
  generatePreKeys,
  generateSignedPreKey,
  keyPairFromPrivate,
  LEGACY_PROFILE,
  MAX_DEVICE_ID,
  randomBytes,
  toBase64,
  type DeviceBundle,
  type DeviceId,
  type KeyPair,
  type OmemoProfile,
  type OmemoStorage,
  type PreKeyPair,
  type RandomSource,
  type SignedPreKeyPair,
  type StoredSignedPreKey,
} from '@curlew/omemo';

/** How long a signed prekey stays the one the bundle advertises (ADR 0006 §3: 7 days). */
export const SIGNED_PREKEY_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a retired signed prekey is kept.
 *
 * One period beyond its own, so a key exchange built from the bundle a peer fetched just before
 * the rotation still resolves. Deleting on rotation would turn every delayed first contact into
 * `no-session`.
 */
export const SIGNED_PREKEY_RETENTION_MS = 2 * SIGNED_PREKEY_PERIOD_MS;

/** libsignal's registration ids are `1 … 16380`; the bundle format has a slot for ours. */
const MAX_REGISTRATION_ID = 16380;

/** How many times a random device id is redrawn before the account's list is given up on. */
const DEVICE_ID_ATTEMPTS = 16;

export interface OmemoDeviceOptions {
  /** Which OMEMO profile to speak. Defaults to the legacy one. */
  readonly profile?: OmemoProfile;
  /** Where key material comes from. Defaults to `crypto.getRandomValues`. */
  readonly random?: RandomSource;
  /** The clock the 7-day rotation is measured against. */
  readonly now?: () => Date;
}

/** Our device, as everything above needs it: the id we publish and the key we sign with. */
export interface OwnDevice {
  readonly deviceId: DeviceId;
  readonly identityKey: KeyPair;
  readonly registrationId: number;
}

/**
 * Our device, or undefined when this account has never been one.
 *
 * A device record that does not decode throws rather than returning undefined: "no device" makes
 * the caller register a NEW one, which would publish a second identity key and leave every peer
 * encrypting for a device whose sessions are gone. A broken record is a broken account file, and
 * saying so beats quietly starting over.
 */
export async function loadOwnDevice(storage: OmemoStorage): Promise<OwnDevice | undefined> {
  const record = await storage.loadDevice();
  if (record === undefined) return undefined;
  return {
    deviceId: record.deviceId,
    identityKey: keyPairFromPrivate(fromBase64(record.identityPrivateKey)),
    registrationId: record.registrationId,
  };
}

/**
 * Our device, created on first use.
 *
 * `published` is the account's own device list as the server has it. The new id is drawn at
 * random and checked against that list (ADR 0006 §3) — counting up from 1 would collide with
 * whatever the person's phone picked, and a collision means two devices answering to one `rid`.
 */
export async function ensureOwnDevice(
  storage: OmemoStorage,
  published: readonly DeviceId[] = [],
  options: OmemoDeviceOptions = {},
): Promise<OwnDevice> {
  return storage.transaction(async () => {
    const existing = await loadOwnDevice(storage);
    if (existing !== undefined) return existing;

    const random = options.random ?? defaultRandomSource;
    const identityKey = generateKeyPair(random);
    const device: OwnDevice = {
      deviceId: pickDeviceId(published, random),
      identityKey,
      registrationId: (readUint(randomBytes(2, random)) % MAX_REGISTRATION_ID) + 1,
    };
    await storage.saveDevice({
      deviceId: device.deviceId,
      identityPrivateKey: toBase64(identityKey.privateKey),
      registrationId: device.registrationId,
    });
    return device;
  });
}

/** The bundle to publish, and whether it differs from the one already on the server. */
export interface BundleState {
  readonly bundle: DeviceBundle;
  /** A key was rotated or added, so the node has to be republished. */
  readonly changed: boolean;
}

/**
 * Rotate and replenish what needs it, and return the bundle that now describes this device.
 *
 * Called on every connect of the lease holder. `changed` is false for the ordinary case where
 * nothing expired and no prekey was spent, and the caller then publishes nothing — a bundle
 * republished for no reason makes every peer refetch it.
 */
export async function ensureBundle(
  storage: OmemoStorage,
  device: OwnDevice,
  options: OmemoDeviceOptions = {},
): Promise<BundleState> {
  const profile = options.profile ?? LEGACY_PROFILE;
  const random = options.random ?? defaultRandomSource;
  const now = (options.now ?? (() => new Date()))();

  return storage.transaction(async () => {
    const signed = await ensureSignedPreKey(storage, device, now, random);
    const preKeys = await ensurePreKeys(storage, profile, random);
    return {
      bundle: buildBundle(device.identityKey, signed.key, preKeys.keys),
      changed: signed.changed || preKeys.changed,
    };
  });
}

/**
 * The prekeys a key exchange spent, deleted for good.
 *
 * Separate from the receive path because of the MAM catch-up (ADR 0006 §3): the same prekey may
 * appear in several archived exchanges, so during a catch-up it is only MARKED, and the deletion
 * waits until the page loop has ended.
 */
export async function deleteConsumedPreKeys(storage: OmemoStorage): Promise<number[]> {
  return storage.transaction(async () => {
    const deleted: number[] = [];
    for (const id of await storage.listPreKeyIds()) {
      const stored = await storage.loadPreKey(id);
      if (stored?.consumedAt === undefined) continue;
      await storage.deletePreKey(id);
      deleted.push(id);
    }
    return deleted;
  });
}

/**
 * The current signed prekey, rotated when it has served its period.
 *
 * An unparseable `createdAt` counts as expired. The alternative — treating it as fresh — would
 * pin the account to one signed prekey forever, and rotating once too often costs a publish.
 */
async function ensureSignedPreKey(
  storage: OmemoStorage,
  device: OwnDevice,
  now: Date,
  random: RandomSource,
): Promise<{ key: SignedPreKeyPair; changed: boolean }> {
  const currentId = await storage.loadCurrentSignedPreKeyId();
  const current = currentId === undefined ? undefined : await storage.loadSignedPreKey(currentId);
  if (current !== undefined && ageMs(current.createdAt, now) < SIGNED_PREKEY_PERIOD_MS) {
    return { key: restore(current), changed: false };
  }

  const ids = await storage.listSignedPreKeyIds();
  const id = Math.max(0, ...ids) + 1;
  const key = generateSignedPreKey(device.identityKey, id, random);
  await storage.saveSignedPreKey(
    {
      id,
      privateKey: toBase64(key.privateKey),
      signature: toBase64(key.signature),
      createdAt: now.toISOString(),
    },
    true,
  );

  for (const old of ids) {
    if (old === id) continue;
    const stored = await storage.loadSignedPreKey(old);
    if (stored !== undefined && ageMs(stored.createdAt, now) < SIGNED_PREKEY_RETENTION_MS) continue;
    await storage.deleteSignedPreKey(old);
  }
  return { key, changed: true };
}

/**
 * The unspent one-time prekeys, topped back up to the profile's count when they run low.
 *
 * Topped up to `preKeyCount` rather than by a fixed number, and only once the count is under
 * `preKeyRefillThreshold`, so a busy account republishes its bundle on the order of once per 25
 * first contacts instead of once per contact.
 */
async function ensurePreKeys(
  storage: OmemoStorage,
  profile: OmemoProfile,
  random: RandomSource,
): Promise<{ keys: PreKeyPair[]; changed: boolean }> {
  const keys: PreKeyPair[] = [];
  for (const id of await storage.listPreKeyIds()) {
    const stored = await storage.loadPreKey(id);
    if (stored === undefined || stored.consumedAt !== undefined) continue;
    // A row whose private key does not decode is skipped, not thrown over: the refill below
    // replaces it, and one bad prekey must not cost the account its whole bundle.
    try {
      keys.push({ id, ...keyPairFromPrivate(fromBase64(stored.privateKey)) });
    } catch {
      continue;
    }
  }
  if (keys.length >= profile.preKeyRefillThreshold) return { keys, changed: false };

  const missing = profile.preKeyCount - keys.length;
  const firstId = await storage.reservePreKeyIds(missing);
  const fresh = generatePreKeys(firstId, missing, random);
  await storage.savePreKeys(fresh.map(({ id, privateKey }) => ({ id, privateKey: toBase64(privateKey) })));
  return { keys: [...keys, ...fresh], changed: true };
}

/** A stored signed prekey as the pair the bundle builder wants. */
function restore(stored: StoredSignedPreKey): SignedPreKeyPair {
  return {
    id: stored.id,
    ...keyPairFromPrivate(fromBase64(stored.privateKey)),
    signature: fromBase64(stored.signature),
  };
}

/** Milliseconds since an ISO timestamp; `Infinity` when it does not parse. */
function ageMs(iso: string, now: Date): number {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? Number.POSITIVE_INFINITY : now.getTime() - then;
}

/** A device id in `1 … 2³¹ − 1` that the account has not already published. */
function pickDeviceId(published: readonly DeviceId[], random: RandomSource): DeviceId {
  const taken = new Set(published);
  for (let attempt = 0; attempt < DEVICE_ID_ATTEMPTS; attempt++) {
    const id = (readUint(randomBytes(4, random)) % MAX_DEVICE_ID) + 1;
    if (!taken.has(id)) return id;
  }
  // Sixteen collisions against a list of at most a few dozen entries is not bad luck; it is a
  // random source that is not random. Failing beats publishing a second device under one id.
  throw new Error('could not pick a free OMEMO device id');
}

function readUint(bytes: Uint8Array): number {
  return bytes.reduce((acc, byte) => acc * 256 + byte, 0);
}
