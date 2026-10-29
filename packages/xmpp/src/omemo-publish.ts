/**
 * Announcing this device to the server, and reading what other devices announced (ADR 0006 §3).
 *
 * Everything here is a PEP round trip, which means everything here WRITES or asks on the
 * account's behalf: it runs only for a caller that holds the `xmpp.omemo` grant. The receive path
 * itself needs none of it — a message is decrypted with keys already in the account file — so an
 * account without the grant syncs exactly as it did before, with its encrypted messages indexed
 * textless.
 *
 * The one rule this module exists to keep: **a device list is read, changed and written back,
 * never written from what we alone know.** Publishing just our own id is the classic OMEMO bug —
 * it unpublishes the person's phone, and their contacts' clients stop encrypting for it until
 * they next come online and notice.
 */

import {
  assertBundleUsable,
  type DeviceBundle,
  type DeviceId,
  type DeviceListRecord,
  type OmemoStorage,
} from '@curlew/omemo';
import { XmppQueryError } from './api.ts';
import { ensureBundle, ensureOwnDevice, type OmemoDeviceOptions, type OwnDevice } from './omemo-device.ts';
import {
  bundlePublish,
  bundleQuery,
  deviceListPublish,
  deviceListQuery,
  parseBundle,
  parseDeviceList,
} from './omemo-stanza.ts';
import type { XmlElement } from './stanza.ts';

/**
 * How long a cached device list is used before the server is asked again.
 *
 * An hour: long enough that a catch-up over many chats does not become a PEP storm, short enough
 * that a device the person added this morning is encrypted for by the afternoon.
 */
export const DEVICE_LIST_TTL_MS = 60 * 60 * 1000;

/** The PEP round trips this module needs — implemented by `XmppLink`, faked in the tests. */
export interface PepPort {
  /** The `<pubsub>` of an `<iq type='get' to='jid'>`, or undefined when the node is not there. */
  pepGet(jid: string, payload: XmlElement): Promise<XmlElement | undefined>;
  /** An `<iq type='set'>` to the account's own PEP service. Throws {@link XmppQueryError}. */
  pepSet(payload: XmlElement): Promise<void>;
}

/** What {@link announceDevice} had to do, for the caller to log or test. */
export interface Announcement {
  readonly device: OwnDevice;
  /** The device list had to be rewritten — our id was missing from it. */
  readonly deviceListPublished: boolean;
  /** The bundle was (re)published: first run, a rotation, or spent prekeys replaced. */
  readonly bundlePublished: boolean;
}

/**
 * Make sure this account has a device, that the server's list names it, and that its bundle is
 * current. Safe to call on every connect: the ordinary run publishes nothing.
 */
export async function announceDevice(
  pep: PepPort,
  storage: OmemoStorage,
  selfJid: string,
  options: OmemoDeviceOptions = {},
): Promise<Announcement> {
  const published = parseDeviceList(await pep.pepGet(selfJid, deviceListQuery()));
  const device = await ensureOwnDevice(storage, published, options);

  let deviceListPublished = false;
  if (!published.includes(device.deviceId)) {
    // Our id ADDED to theirs, never instead of theirs — see the module comment.
    await publish(pep, (open) => deviceListPublish([...published, device.deviceId], open));
    deviceListPublished = true;
  }

  const state = await ensureBundle(storage, device, options);
  // `changed` is false whenever nothing rotated and no prekey was spent. Republishing anyway
  // would make every peer refetch a bundle that did not move.
  const bundlePublished = state.changed || deviceListPublished;
  if (bundlePublished) {
    await publish(pep, (open) => bundlePublish(device.deviceId, state.bundle, open));
  }

  await storage.saveDeviceList(selfJid, {
    deviceIds: deviceListPublished ? [...published, device.deviceId].sort((a, b) => a - b) : published,
    fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
  });
  return { device, deviceListPublished, bundlePublished };
}

/**
 * The answer to "which devices does this JID have?".
 *
 * `failed` is not the same as an empty list, and the send path is why: an empty list means the
 * peer has no OMEMO and a plaintext message is what they can read, while `failed` means we do
 * not know — and ADR 0006 §7 refuses to send rather than guess, because guessing wrong sends in
 * the clear. `stale` marks a list we served from an expired cache after the server would not
 * answer: good enough to encrypt for, not good enough to conclude the peer dropped a device.
 */
export type DeviceListLookup =
  | { readonly kind: 'list'; readonly deviceIds: DeviceId[]; readonly stale: boolean }
  | { readonly kind: 'failed' };

/**
 * A JID's device ids, from the cache while it is fresh.
 *
 * A server that answers with an error leaves the cached list in place and returns it: a PEP node
 * that is briefly unavailable should not make a contact look like they left OMEMO behind. With
 * no cache to fall back on there is no list at all, and the caller is told so.
 */
export async function fetchDeviceList(
  pep: PepPort,
  storage: OmemoStorage,
  jid: string,
  options: { now?: () => Date; ttlMs?: number } = {},
): Promise<DeviceListLookup> {
  const now = (options.now ?? (() => new Date()))();
  const ttl = options.ttlMs ?? DEVICE_LIST_TTL_MS;
  const cached = await storage.loadDeviceList(jid);
  const age = now.getTime() - Date.parse(cached?.fetchedAt ?? '');
  if (cached !== undefined && Number.isFinite(age) && age >= 0 && age < ttl) {
    return { kind: 'list', deviceIds: [...cached.deviceIds], stale: false };
  }

  let deviceIds: DeviceId[];
  try {
    deviceIds = parseDeviceList(await pep.pepGet(jid, deviceListQuery()));
  } catch {
    if (cached === undefined) return { kind: 'failed' };
    return { kind: 'list', deviceIds: [...cached.deviceIds], stale: true };
  }
  const record: DeviceListRecord = { deviceIds, fetchedAt: now.toISOString() };
  await storage.saveDeviceList(jid, record);
  return { kind: 'list', deviceIds, stale: false };
}

/**
 * The answer to "what did this device publish?".
 *
 * Same distinction as {@link DeviceListLookup} and for the same reason, with one more case:
 * `none` is a device that published nothing usable — it announced itself and has not been
 * online since, or its signed prekey signature does not check out (`assertBundleUsable`), which
 * is not a bundle this account may build a session on either way.
 */
export type BundleLookup =
  | { readonly kind: 'bundle'; readonly bundle: DeviceBundle }
  | { readonly kind: 'none' }
  | { readonly kind: 'failed' };

/** One device's published bundle. */
export async function fetchBundle(pep: PepPort, jid: string, deviceId: DeviceId): Promise<BundleLookup> {
  let bundle: DeviceBundle | undefined;
  try {
    bundle = parseBundle(await pep.pepGet(jid, bundleQuery(deviceId)));
  } catch {
    return { kind: 'failed' };
  }
  if (bundle === undefined) return { kind: 'none' };
  try {
    await assertBundleUsable(bundle);
  } catch {
    return { kind: 'none' };
  }
  return { kind: 'bundle', bundle };
}

/**
 * Publish a node, retrying without `<publish-options>` when the server rejects them.
 *
 * `conflict` is what a server answers when the node already exists with a different
 * configuration — an older client created it before anyone asked for an open access model. The
 * retry keeps the publish working on such a node instead of leaving the device unannounced; what
 * it cannot do is widen the access model, so a peer who is not subscribed to our presence may
 * still not see the bundle there. That is the server's existing configuration, not ours to fix
 * from here.
 */
async function publish(pep: PepPort, build: (openAccessModel: boolean) => XmlElement): Promise<void> {
  try {
    await pep.pepSet(build(true));
  } catch (err) {
    if (!(err instanceof XmppQueryError) || err.condition !== 'conflict') throw err;
    await pep.pepSet(build(false));
  }
}
