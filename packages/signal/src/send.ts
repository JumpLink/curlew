/**
 * The Signal backend's send path: one plain-text 1:1 message, behind a saved `signal.send` grant.
 *
 * The address is the recipient's ACI, exactly as the index and `conversations_list` hold a direct
 * chat's remote id (`peerOf` in `map.ts`), so a grant target `<account>/<address>` matches what a
 * caller reads there. A phone number is not an address here: Signal resolves one to an ACI through
 * a service curlew does not speak (CDSI), and a grant has to name what the caller can read back.
 *
 * What this path does NOT do, and refuses rather than approximates:
 *
 * - **groups.** A group message is a sender-key message to the group's members, and the member
 *   list plus the credentials to send it come from Signal's storage service, which curlew does not
 *   sync. It could not even name the recipients, so `group:<base64 id>` is refused by address.
 * - **sealed sender.** Sending unidentified needs a sender certificate from
 *   `GET /v1/certificate/delivery`; nothing in this package fetches or stores one. A message
 *   therefore goes out identified — which changes nothing the recipient sees, and nothing the
 *   server does not already know: its socket is authenticated as this device.
 * - **attachments, styles, quotes, reactions, edits.** The body is the message.
 * - **splitting.** Past `SIGNAL_MAX_MESSAGE_BYTES` Signal sends the text as a long-message
 *   attachment; curlew sends no attachments, so a longer text is refused, never cut.
 *
 * The fan-out is the part that has to be right: one ciphertext per recipient DEVICE, plus a
 * `SyncMessage.Sent` transcript to the user's own other devices — without that the phone never
 * shows what curlew wrote. The server answers a wrong device list with 409 (a device was missed
 * or is gone) or 410 (a session the recipient replaced); both are corrected and the send retried.
 *
 * Every request leaves through the per-permit gate in `guard.ts`, which allows two paths for the
 * permitted service ids and nothing else. The permit is checked here again, before any of it.
 */

import {
  _,
  fmt,
  type MessageSender,
  type SendingMessage,
  type SendPermit,
  type SenderFeatures,
  type SentMessage,
} from '@curlew/protocol';
import type * as Core from '@signalapp/libsignal-client';
import type { ChatFetch, ChatResponseLike } from './guard.ts';
import type { SignalLib } from './lib.ts';
import { GROUP_PREFIX, messageRemoteId } from './map.ts';
import { basicAuth, JSON_TYPE, jsonBody } from './net.ts';
import { type DeviceAccount, fromBase64, NS, type SignalProtocolStore, toBase64 } from './protocol-store.ts';
import { ProtoWriter } from './proto.ts';
import { EnvelopeType, isAci, normalizeServiceId, padPlaintext, uuidToBytes } from './schema.ts';

/**
 * The longest text one message may carry. curlew refuses more rather than splitting it.
 *
 * Signal's own limit, from Signal-Desktop `ts/util/longAttachment.ts`
 * (`MAX_MESSAGE_BODY_BYTE_LENGTH = 2 * KIBIBYTE`): past it a client moves the whole text into a
 * `text/x-signal-plain` attachment and sends a truncated body. That needs an attachment upload,
 * which this path does not do, so the honest answer past the limit is no.
 */
export const SIGNAL_MAX_MESSAGE_BYTES = 2048;

/**
 * Field numbers from Signal's `SignalService.proto` (Signal-Desktop, Copyright Signal Messenger,
 * LLC, AGPL-3.0-only) — the few an outgoing text needs.
 *
 * A minimal `DataMessage` is a body and a timestamp. Fields 5 and 23 are left out on purpose:
 * `decodeDataMessage` reads their mere presence as a disappearing-messages timer, so writing a
 * zero there would make every message curlew sends look like a timer change on the next sync.
 */
const F = {
  content: { dataMessage: 1, syncMessage: 2 },
  data: { body: 1, timestamp: 7 },
  sync: { sent: 1 },
  sent: {
    timestamp: 2,
    message: 3,
    /** Deprecated string form. Written next to field 12: an older phone reads only this one. */
    destinationServiceId: 7,
    destinationServiceIdBinary: 12,
  },
} as const;

/** How often a 409/410 may send the request again before the mismatch counts as unresolvable. */
const MAX_CORRECTIONS = 3;

const UTF8 = new TextEncoder();

/** One bundle as `GET /v2/keys/{serviceId}/*` returns it; every key base64. */
interface DeviceBundleJson {
  deviceId: number;
  registrationId: number;
  preKey?: { keyId: number; publicKey: string } | null;
  signedPreKey?: { keyId: number; publicKey: string; signature: string } | null;
  pqPreKey?: { keyId: number; publicKey: string; signature: string } | null;
}

interface PreKeyResponseJson {
  identityKey: string;
  devices?: DeviceBundleJson[];
}

/** What the server names when it disagrees about a recipient's devices. */
interface MismatchJson {
  missingDevices?: number[];
  extraDevices?: number[];
  staleDevices?: number[];
}

/** One encrypted copy for one device, as `PUT /v1/messages/{serviceId}` takes it. */
interface OutgoingMessageJson {
  type: number;
  destinationDeviceId: number;
  destinationRegistrationId: number;
  content: string;
}

/** What one granted sender needs. `fetch` is already wrapped in `sendFetch` by `openSender`. */
export interface SignalSendSession {
  lib: SignalLib;
  store: SignalProtocolStore;
  account: DeviceAccount;
  fetch: ChatFetch;
  onClose: () => Promise<void>;
}

/** A status, never the response body: that can quote the message or name other people. */
function statusOf(response: ChatResponseLike): string {
  return `HTTP ${response.status}`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson<T>(response: ChatResponseLike, what: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(response.body ?? new Uint8Array())) as T;
  } catch {
    throw new Error(fmt(_('Signal answered {what} with something that is not JSON'), { what }));
  }
}

export class SignalSender implements MessageSender {
  /**
   * Signal's body is plain text. It does carry styling, as ranges in a second field
   * (`BodyRange`), which is not curlew's chat Markdown and not what this path sends.
   */
  readonly features: SenderFeatures = { markdown: false };
  private readonly lib: SignalLib;
  private readonly store: SignalProtocolStore;
  private readonly account: DeviceAccount;
  private readonly fetch: ChatFetch;
  private readonly permit: SendPermit;
  private readonly onClose: () => Promise<void>;

  constructor(session: SignalSendSession, permit: SendPermit) {
    this.lib = session.lib;
    this.store = session.store;
    this.account = session.account;
    this.fetch = session.fetch;
    this.permit = permit;
    this.onClose = session.onClose;
  }

  async send(message: SendingMessage): Promise<SentMessage> {
    const aci = this.recipient(message.to);
    const bytes = UTF8.encode(message.text).length;
    if (bytes > SIGNAL_MAX_MESSAGE_BYTES) {
      throw new Error(
        fmt(_('a Signal message holds at most {max} bytes of text, this one has {bytes} — shorten it'), {
          max: String(SIGNAL_MAX_MESSAGE_BYTES),
          bytes: String(bytes),
        }),
      );
    }
    // A note to self is the transcript alone — the same way Signal implements Note to Self. There
    // is no `DataMessage` to oneself: it would arrive back as a message from this device.
    const own = aci === this.account.aci;
    // The sent timestamp is the message's identity on this network, together with its author.
    const timestamp = Date.now();
    const dataMessage = new ProtoWriter()
      .string(F.data.body, message.text)
      .uint(F.data.timestamp, timestamp);

    // The recipient first: a transcript on the phone for a message the recipient never got would
    // show the user something that does not exist.
    if (!own) {
      const content = new ProtoWriter().message(F.content.dataMessage, dataMessage).finish();
      await this.deliver(aci, content, timestamp);
    }

    const sent = new ProtoWriter()
      .uint(F.sent.timestamp, timestamp)
      .message(F.sent.message, dataMessage)
      .string(F.sent.destinationServiceId, aci)
      .bytes(F.sent.destinationServiceIdBinary, uuidToBytes(aci));
    const transcript = new ProtoWriter()
      .message(F.content.syncMessage, new ProtoWriter().message(F.sync.sent, sent))
      .finish();

    let warning: string | undefined;
    let delivered = 0;
    try {
      delivered = await this.deliver(this.account.aci, transcript, timestamp, [this.account.deviceId]);
    } catch (error) {
      // For a note to self the transcript IS the delivery: its failure means nothing was sent.
      if (own) throw error;
      // Otherwise the recipient already has the message. Reporting the call as failed would get
      // it sent twice on a retry, so the delivery stands and the gap is named in the answer.
      warning = fmt(
        _(
          "the message was delivered, but this account's other devices were not told about it ({reason}) — it will not appear on the phone",
        ),
        { reason: reasonOf(error) },
      );
    }
    if (own && delivered === 0) {
      throw new Error(
        _(
          "a note to self is stored on this account's other devices, and this account has none — nothing was sent",
        ),
      );
    }

    return {
      target: message.to,
      // What the receive path uses as the remote id of our own messages, so the transcript that
      // comes back replaces curlew's local echo instead of adding a second copy.
      id: messageRemoteId(this.account.aci, timestamp),
      sentAt: new Date(timestamp).toISOString(),
      chatRemoteId: aci,
      encrypted: true,
      ...(warning === undefined ? {} : { warning }),
    };
  }

  async close(): Promise<void> {
    await this.onClose();
  }

  /** The ACI the permit names, or a refusal — the permit is the second check. */
  private recipient(to: string): string {
    if (to.startsWith(GROUP_PREFIX)) {
      throw new Error(
        _(
          'curlew cannot send to a Signal group: a group message needs the member list and credentials from Signal\'s storage service, which curlew does not sync — send it from a Signal client',
        ),
      );
    }
    const aci = normalizeServiceId(to);
    if (!aci || !isAci(aci)) {
      throw new Error(
        fmt(
          _(
            '{address} is not a Signal account id — use the id `conversations_list` shows for the chat, not a phone number',
          ),
          { address: to },
        ),
      );
    }
    if (!this.permit.addresses.some((granted) => normalizeServiceId(granted) === aci)) {
      throw new Error(
        fmt(_('sending to {address} is not granted for account {account}'), {
          address: to,
          account: this.permit.account,
        }),
      );
    }
    return aci;
  }

  private get local(): Core.ProtocolAddress {
    return this.lib.core.ProtocolAddress.new(this.account.aci, this.account.deviceId);
  }

  private get auth(): [string, string] {
    return basicAuth(`${this.account.aci}.${this.account.deviceId}`, this.account.password);
  }

  /**
   * Encrypt `content` for every device of `serviceId` and PUT it. Returns how many devices got it.
   *
   * The flush is the load-bearing part, and it happens in exactly one place: after a 2xx. Ratchet
   * state that reached the server MUST survive, or the next message to that device is
   * undecryptable for the recipient. State from a PUT that did NOT reach the server must NOT
   * survive — the session has to stay where the recipient believes it is — so every other path
   * out of here leaves the changes dirty, and `onClose` discards them.
   */
  private async deliver(
    serviceId: string,
    content: Uint8Array,
    timestamp: number,
    exclude: readonly number[] = [],
  ): Promise<number> {
    let devices = await this.devicesOf(serviceId, exclude, false);
    for (let correction = 0; ; correction++) {
      if (devices.length === 0) return 0;
      const messages: OutgoingMessageJson[] = [];
      for (const deviceId of devices) messages.push(await this.encryptFor(serviceId, deviceId, content));
      const response = await this.fetch({
        verb: 'PUT',
        path: `/v1/messages/${serviceId}?story=false`,
        headers: [this.auth, JSON_TYPE],
        body: jsonBody({ messages, timestamp, online: false, urgent: true }),
      });
      if (response.status >= 200 && response.status < 300) {
        this.store.flush();
        return devices.length;
      }
      if (response.status === 409 || response.status === 410) {
        if (correction >= MAX_CORRECTIONS) {
          throw new Error(
            _(
              "Signal kept disagreeing about the recipient's devices — nothing was sent; try again, or send it from a Signal client",
            ),
          );
        }
        devices = await this.correctDevices(serviceId, response, exclude);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          _('Signal refused this device (unauthorized) — nothing was sent; the device may be unlinked'),
        );
      }
      if (response.status === 428) {
        throw new Error(_('Signal wants a rate-limit challenge answered — nothing was sent'));
      }
      throw new Error(
        fmt(_('Signal refused the message ({status}) — nothing was sent'), { status: statusOf(response) }),
      );
    }
  }

  private async encryptFor(
    serviceId: string,
    deviceId: number,
    content: Uint8Array,
  ): Promise<OutgoingMessageJson> {
    const S = this.lib.core;
    const address = S.ProtocolAddress.new(serviceId, deviceId);
    const ciphertext = await S.signalEncrypt(
      padPlaintext(content),
      address,
      this.local,
      this.store.sessions,
      this.store.identities,
    );
    const stored = this.store.get(NS.session, `${serviceId}.${deviceId}`);
    if (!stored) throw new Error(`no session for ${serviceId}.${deviceId} after encrypting`);
    return {
      type: this.envelopeType(ciphertext.type()),
      destinationDeviceId: deviceId,
      destinationRegistrationId: S.SessionRecord.deserialize(fromBase64(stored)).remoteRegistrationId(),
      content: toBase64(ciphertext.serialize()),
    };
  }

  /** libsignal's ciphertext type → the `Envelope.Type` the server puts on the delivered envelope. */
  private envelopeType(type: number): number {
    const T = this.lib.core.CiphertextMessageType;
    if (type === T.PreKey) return EnvelopeType.PREKEY_MESSAGE;
    if (type === T.Whisper) return EnvelopeType.DOUBLE_RATCHET;
    if (type === T.Plaintext) return EnvelopeType.PLAINTEXT_CONTENT;
    throw new Error(`libsignal produced ciphertext type ${type}, which curlew does not send`);
  }

  /**
   * The devices to encrypt for. Sessions curlew already has are used as they are — asking the
   * server for a device list on every message would be a request per send for nothing, and a
   * mismatch is what 409/410 are for. `refresh` is that correction: then the server's list wins.
   */
  private async devicesOf(
    serviceId: string,
    exclude: readonly number[],
    refresh: boolean,
  ): Promise<number[]> {
    if (!refresh) {
      const known = this.sessionDevices(serviceId, exclude);
      if (known.length > 0) return known;
    }
    return this.fetchBundles(serviceId, exclude);
  }

  /** Every device of `serviceId` this account has a session with that can still encrypt. */
  private sessionDevices(serviceId: string, exclude: readonly number[]): number[] {
    const prefix = `${serviceId}.`;
    return this.store
      .keys(NS.session)
      .filter((key) => key.startsWith(prefix))
      .map((key) => Number(key.slice(prefix.length)))
      .filter((id) => Number.isInteger(id) && id > 0 && !exclude.includes(id))
      .filter((id) => this.hasLiveSession(serviceId, id))
      .sort((a, b) => a - b);
  }

  private hasLiveSession(serviceId: string, deviceId: number): boolean {
    const stored = this.store.get(NS.session, `${serviceId}.${deviceId}`);
    if (!stored) return false;
    try {
      return this.lib.core.SessionRecord.deserialize(fromBase64(stored)).hasCurrentState();
    } catch {
      return false;
    }
  }

  /**
   * Ask for every device's pre-key bundle and start a session with each one curlew cannot already
   * write to. Returns the server's device list.
   *
   * A device with a live session keeps it: processing a bundle for it would start a second session
   * and make the next message a pre-key message for no reason.
   */
  private async fetchBundles(serviceId: string, exclude: readonly number[]): Promise<number[]> {
    const response = await this.fetch({
      verb: 'GET',
      path: `/v2/keys/${serviceId}/*`,
      headers: [this.auth, JSON_TYPE],
    });
    if (response.status === 404) {
      throw new Error(
        fmt(_('Signal has no account {address} — nothing was sent'), { address: serviceId }),
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        fmt(_('Signal did not hand over the keys for {address} ({status}) — nothing was sent'), {
          address: serviceId,
          status: statusOf(response),
        }),
      );
    }
    const body = parseJson<PreKeyResponseJson>(response, 'a pre-key request');
    const identityKey = this.lib.core.PublicKey.deserialize(fromBase64(body.identityKey));
    const devices: number[] = [];
    for (const bundle of body.devices ?? []) {
      if (exclude.includes(bundle.deviceId)) continue;
      devices.push(bundle.deviceId);
      if (this.hasLiveSession(serviceId, bundle.deviceId)) continue;
      await this.startSession(serviceId, identityKey, bundle);
    }
    this.refuseIdentityChange();
    if (devices.length === 0 && exclude.length === 0) {
      throw new Error(
        fmt(_('Signal lists no device for {address} — nothing was sent'), { address: serviceId }),
      );
    }
    return devices.sort((a, b) => a - b);
  }

  private async startSession(
    serviceId: string,
    identityKey: Core.PublicKey,
    bundle: DeviceBundleJson,
  ): Promise<void> {
    const S = this.lib.core;
    const signed = bundle.signedPreKey;
    const pq = bundle.pqPreKey;
    if (!signed || !pq) {
      // Both are required to start a session on this libsignal, and every registered device
      // publishes both. One missing means the device is not in a state curlew can write to.
      throw new Error(
        fmt(
          _(
            'a device of {address} publishes no usable keys, so curlew cannot start a session with it — nothing was sent',
          ),
          { address: serviceId },
        ),
      );
    }
    const preKeyBundle = S.PreKeyBundle.new(
      bundle.registrationId,
      bundle.deviceId,
      bundle.preKey ? bundle.preKey.keyId : null,
      bundle.preKey ? S.PublicKey.deserialize(fromBase64(bundle.preKey.publicKey)) : null,
      signed.keyId,
      S.PublicKey.deserialize(fromBase64(signed.publicKey)),
      fromBase64(signed.signature),
      identityKey,
      pq.keyId,
      S.KEMPublicKey.deserialize(fromBase64(pq.publicKey)),
      fromBase64(pq.signature),
    );
    await S.processPreKeyBundle(
      preKeyBundle,
      S.ProtocolAddress.new(serviceId, bundle.deviceId),
      this.local,
      this.store.sessions,
      this.store.identities,
    );
  }

  /**
   * Refuse when a safety number changed as part of THIS send.
   *
   * The receive path accepts every identity (see `isTrustedIdentity`): a message already sent
   * cannot be unsent, so refusing to read it would only hide it. Sending is the other direction —
   * a changed key means the next message would go to a device the user has not confirmed, and
   * that is exactly the case where "ask first" is the whole point of a safety number.
   *
   * The new key is flushed before the refusal, so the explicit retry IS the acknowledgement: the
   * stored key is then the new one, no change is detected, and the message goes out.
   */
  private refuseIdentityChange(): void {
    const changed = this.store.takeIdentityChanges();
    if (changed.length === 0) return;
    this.store.flush();
    throw new Error(
      fmt(
        _(
          'the safety number of {address} changed — nothing was sent; check it with them, then send again to accept the new one',
        ),
        { address: changed.map((change) => change.aci).join(', ') },
      ),
    );
  }

  /**
   * A 409 or 410 → the device list to send to instead.
   *
   * 409 names devices curlew missed (`missingDevices`) and devices that are gone
   * (`extraDevices`); 410 names sessions the recipient replaced (`staleDevices`). A session that
   * is gone or stale is forgotten, and the server's list is then read fresh: after a mismatch it
   * is the only list that is right, and one request for all devices costs less than one each.
   */
  private async correctDevices(
    serviceId: string,
    response: ChatResponseLike,
    exclude: readonly number[],
  ): Promise<number[]> {
    const body = parseJson<MismatchJson>(response, 'a message');
    const gone = [...(body.extraDevices ?? []), ...(body.staleDevices ?? [])];
    for (const deviceId of gone) this.store.set(NS.session, `${serviceId}.${deviceId}`, null);
    if (gone.length === 0 && (body.missingDevices ?? []).length === 0) {
      throw new Error(
        fmt(
          _('Signal reported a device mismatch ({status}) without naming a device — nothing was sent'),
          { status: statusOf(response) },
        ),
      );
    }
    return this.devicesOf(serviceId, exclude, true);
  }
}
