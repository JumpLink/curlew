/**
 * The OMEMO grammar: PEP nodes for device lists and bundles, and the `<encrypted>` element.
 *
 * Pure like `stanza.ts` — parsers take an `XmlElement`, builders return xmpp.js elements, nothing
 * here opens a socket or touches a key store. The crypto is `@curlew/omemo`'s; what this module
 * owns is the XML around it and the base64 boundary between the two.
 *
 * Only the legacy namespace (`eu.siacs.conversations.axolotl`) is produced. A stanza in
 * `urn:xmpp:omemo:2` is RECOGNISED, by {@link omemoVersionOf}, so that a message encrypted with
 * it can be indexed as `undecryptable: v2` instead of looking like an empty message — ADR 0006 §1
 * chose one wire format, and silently ignoring the other one is how a conversation goes missing.
 *
 * The node names are part of the protocol, not a convention: a peer's client looks for exactly
 * `…axolotl.devicelist` and `…axolotl.bundles:<device id>`, and the bundle node's id is the
 * DEVICE's, which is why {@link bundleNode} takes one.
 */

import xml from '@xmpp/xml';
import {
  decodePublicKey,
  fromBase64,
  toBase64,
  MAX_DEVICE_ID,
  type DeviceBundle,
  type DeviceId,
  type PublishedPreKey,
} from '@curlew/omemo';
import { NS, type XmlElement } from './stanza.ts';

/** The PEP node every device of an account publishes its device id into. */
export const DEVICE_LIST_NODE = `${NS.omemoLegacy}.devicelist`;

/** The PEP node one device publishes its bundle into. */
export function bundleNode(deviceId: DeviceId): string {
  return `${NS.omemoLegacy}.bundles:${deviceId}`;
}

/**
 * The item id both nodes use.
 *
 * `current` rather than an auto-generated id: a node holds one item that is replaced, and a
 * server that kept a history of bundles would hand peers prekeys this device has long spent.
 */
const ITEM_ID = 'current';

/** Which OMEMO version a message carries, or null when it carries none. */
export function omemoVersionOf(message: XmlElement): 'legacy' | 'v2' | null {
  if (message.getChild('encrypted', NS.omemoLegacy)) return 'legacy';
  if (message.getChild('encrypted', NS.omemo)) return 'v2';
  return null;
}

// ── device lists ────────────────────────────────────────────────────────

/** `<items node='…devicelist'/>` — ask for a JID's published device ids. */
export const deviceListQuery = () =>
  xml('pubsub', { xmlns: NS.pubsub }, xml('items', { node: DEVICE_LIST_NODE, max_items: '1' }));

/**
 * The device ids of a `<pubsub>` result, deduplicated and sorted.
 *
 * Anything that is not a valid device id is dropped rather than rejected: one malformed entry in
 * a stranger's list must not make the other devices of that JID unreachable.
 */
export function parseDeviceList(pubsub: XmlElement | undefined): DeviceId[] {
  const items = pubsub?.getChild('items');
  const seen = new Set<DeviceId>();
  for (const item of items?.getChildren('item') ?? []) {
    const list = item.getChild('list', NS.omemoLegacy);
    for (const device of list?.getChildren('device') ?? []) {
      const id = Number(device.attrs.id);
      if (Number.isInteger(id) && id >= 1 && id <= MAX_DEVICE_ID) seen.add(id);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * `<publish node='…devicelist'>` with the whole list.
 *
 * The list is published WHOLE every time, because PEP has no "add one": announcing this device
 * means reading the current list and writing it back with our id in it. Dropping the others is
 * the classic OMEMO bug — their owners stop receiving anything until they republish.
 */
export function deviceListPublish(deviceIds: readonly DeviceId[], openAccessModel = true) {
  return xml(
    'pubsub',
    { xmlns: NS.pubsub },
    xml(
      'publish',
      { node: DEVICE_LIST_NODE },
      xml(
        'item',
        { id: ITEM_ID },
        xml(
          'list',
          { xmlns: NS.omemoLegacy },
          ...[...deviceIds].sort((a, b) => a - b).map((id) => xml('device', { id: String(id) })),
        ),
      ),
    ),
    ...(openAccessModel ? [openAccess()] : []),
  );
}

/**
 * `<publish-options>` asking for an open access model.
 *
 * Without it a server may create the node with `presence` access, and then anyone not subscribed
 * to our presence — which includes a stranger we want to start a conversation with — cannot fetch
 * the bundle at all. Conversations sends the same form. A server that rejects the options
 * answers `conflict`; the caller retries without them rather than giving up (see `publishNode`).
 */
function openAccess() {
  return xml(
    'publish-options',
    {},
    xml(
      'x',
      { xmlns: NS.data, type: 'submit' },
      xml(
        'field',
        { var: 'FORM_TYPE', type: 'hidden' },
        xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options'),
      ),
      xml('field', { var: 'pubsub#access_model' }, xml('value', {}, 'open')),
    ),
  );
}

// ── bundles ─────────────────────────────────────────────────────────────

/** `<items node='…bundles:<id>'/>` — ask for one device's published keys. */
export const bundleQuery = (deviceId: DeviceId) =>
  xml('pubsub', { xmlns: NS.pubsub }, xml('items', { node: bundleNode(deviceId), max_items: '1' }));

/**
 * The bundle in a `<pubsub>` result, or undefined when the node is empty or malformed.
 *
 * Undefined rather than an exception: a device that has published no bundle is an ordinary state
 * (it has not come online since announcing itself), and the caller's answer to both is the same —
 * no session with that device. Whether the keys are *trustworthy* is not decided here;
 * `assertBundleUsable` checks the signature, and the caller runs it.
 */
export function parseBundle(pubsub: XmlElement | undefined): DeviceBundle | undefined {
  const item = pubsub?.getChild('items')?.getChildren('item')[0];
  const bundle = item?.getChild('bundle', NS.omemoLegacy);
  if (!bundle) return undefined;

  const signedPreKeyElement = bundle.getChild('signedPreKeyPublic', NS.omemoLegacy);
  const signedPreKeyId = Number(signedPreKeyElement?.attrs.signedPreKeyId);
  const identityKey = decodeKey(bundle.getChildText('identityKey', NS.omemoLegacy));
  const signedPreKey = decodeKey(signedPreKeyElement?.text());
  const signature = decodeBytes(bundle.getChildText('signedPreKeySignature', NS.omemoLegacy));
  if (!identityKey || !signedPreKey || !signature || !Number.isInteger(signedPreKeyId)) return undefined;

  const preKeys: PublishedPreKey[] = [];
  for (const element of bundle.getChild('prekeys', NS.omemoLegacy)?.getChildren('preKeyPublic') ?? []) {
    const id = Number(element.attrs.preKeyId);
    const publicKey = decodeKey(element.text());
    if (Number.isInteger(id) && publicKey) preKeys.push({ id, publicKey });
  }

  return {
    identityKey,
    signedPreKeyId,
    signedPreKey,
    signedPreKeySignature: signature,
    preKeys,
  };
}

/** `<publish node='…bundles:<id>'>` with this device's public keys. */
export function bundlePublish(deviceId: DeviceId, bundle: DeviceBundle, openAccessModel = true) {
  return xml(
    'pubsub',
    { xmlns: NS.pubsub },
    xml(
      'publish',
      { node: bundleNode(deviceId) },
      xml(
        'item',
        { id: ITEM_ID },
        xml(
          'bundle',
          { xmlns: NS.omemoLegacy },
          xml(
            'signedPreKeyPublic',
            { signedPreKeyId: String(bundle.signedPreKeyId) },
            toBase64(bundle.signedPreKey),
          ),
          xml('signedPreKeySignature', {}, toBase64(bundle.signedPreKeySignature)),
          xml('identityKey', {}, toBase64(bundle.identityKey)),
          xml(
            'prekeys',
            {},
            ...bundle.preKeys.map((preKey) =>
              xml('preKeyPublic', { preKeyId: String(preKey.id) }, toBase64(preKey.publicKey)),
            ),
          ),
        ),
      ),
    ),
    ...(openAccessModel ? [openAccess()] : []),
  );
}

// ── the encrypted message ───────────────────────────────────────────────

/** One `<key>`: the payload key material, encrypted for one device. */
export interface EncryptedKey {
  /** The device the key is for — `rid`, the recipient id. */
  readonly deviceId: DeviceId;
  /** Whether the blob is an `OMEMOKeyExchange` rather than a bare message (`prekey='true'`). */
  readonly keyExchange: boolean;
  /** The serialized blob. */
  readonly bytes: Uint8Array;
}

/** A parsed `<encrypted>` element. */
export interface EncryptedStanza {
  /** The SENDING device's id — `sid`. Which device of the sender's JID to open a session with. */
  readonly senderDeviceId: DeviceId;
  /** One entry per addressed device. Ours is found by `rid`; the rest are not ours to read. */
  readonly keys: readonly EncryptedKey[];
  /** The payload cipher's IV. May be 16 bytes from an old Conversations — see `decryptPayload`. */
  readonly iv: Uint8Array;
  /**
   * The ciphertext, or undefined for a message that carries none.
   *
   * A keys-only message is not malformed: it is how a device says "here is a session" without
   * saying anything (XEP-0384 §4.6, Conversations' heartbeat). Decrypting its key material still
   * matters — it advances the ratchet — but there is no body to index.
   */
  readonly payload?: Uint8Array | undefined;
}

/**
 * Parse the `<encrypted>` child of a message, or undefined when there is none or it is broken.
 *
 * Only the legacy namespace parses. A `urn:xmpp:omemo:2` element is a different grammar — the
 * keys live in an `<keys jid='…'>` group per recipient — and misreading it as this one would
 * produce blobs addressed to nobody. {@link omemoVersionOf} is what tells the two apart.
 */
export function parseEncrypted(message: XmlElement): EncryptedStanza | undefined {
  const encrypted = message.getChild('encrypted', NS.omemoLegacy);
  return encrypted === undefined ? undefined : parseEncryptedElement(encrypted);
}

/**
 * The same, for an `<encrypted>` element already in hand — what `ArchivedEntry.omemo` carries.
 *
 * The caller has established the namespace by then (`ArchivedEntry.omemo.version`), so this one
 * does not check it again; handing it a `urn:xmpp:omemo:2` element yields undefined, because the
 * children it looks for are not there under the legacy namespace.
 */
export function parseEncryptedElement(encrypted: XmlElement): EncryptedStanza | undefined {
  const header = encrypted.getChild('header', NS.omemoLegacy);
  if (!header) return undefined;

  const senderDeviceId = Number(header.attrs.sid);
  const iv = decodeBytes(header.getChildText('iv', NS.omemoLegacy));
  if (!Number.isInteger(senderDeviceId) || senderDeviceId < 1 || !iv) return undefined;

  const keys: EncryptedKey[] = [];
  for (const element of header.getChildren('key', NS.omemoLegacy)) {
    const deviceId = Number(element.attrs.rid);
    const bytes = decodeBytes(element.text());
    if (!Number.isInteger(deviceId) || !bytes) continue;
    keys.push({ deviceId, keyExchange: truthy(element.attrs.prekey), bytes });
  }
  if (keys.length === 0) return undefined;

  const payload = decodeBytes(encrypted.getChildText('payload', NS.omemoLegacy));
  return { senderDeviceId, keys, iv, ...(payload === undefined ? {} : { payload }) };
}

/** `prekey='true'` and `prekey='1'` both occur in the wild. */
function truthy(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

/** Base64 text to bytes, or undefined when it is absent, empty or not base64. */
function decodeBytes(text: string | null | undefined): Uint8Array | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  try {
    const bytes = fromBase64(trimmed);
    return bytes.length === 0 ? undefined : bytes;
  } catch {
    return undefined;
  }
}

/** A published public key: base64, then the `0x05` prefix stripped if it carries one. */
function decodeKey(text: string | null | undefined): Uint8Array | undefined {
  const bytes = decodeBytes(text);
  if (bytes === undefined) return undefined;
  try {
    return decodePublicKey(bytes);
  } catch {
    return undefined;
  }
}
