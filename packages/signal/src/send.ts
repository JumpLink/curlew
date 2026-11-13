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
 * - **attachments, styles, reactions, edits.** The body is the message. A reply is a `quote` of
 *   the message it answers: its sent timestamp and its author's ACI, which is what a Signal
 *   remote id is made of.
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
  type ReplyTarget,
  type SendingDeletion,
  type SendingEdit,
  type SendingMessage,
  type SendingReaction,
  type SendPermit,
  type SenderFeatures,
  type SentMessage,
} from '@curlew/protocol';
import { inspectSendFiles } from '@curlew/store';
import type * as Core from '@signalapp/libsignal-client';
import { readFileSync } from 'node:fs';
import type { ChatFetch, ChatResponseLike } from './guard.ts';
import type { SignalLib } from './lib.ts';
import { GROUP_PREFIX, messageRemoteId, parseMessageRemoteId } from './map.ts';
import { basicAuth, JSON_TYPE, jsonBody } from './net.ts';
import { type DeviceAccount, fromBase64, NS, type SignalProtocolStore, toBase64 } from './protocol-store.ts';
import { ProtoWriter } from './proto.ts';
import { EnvelopeType, isAci, normalizeServiceId, padPlaintext, uuidToBytes } from './schema.ts';
import { type AttachmentUploader, httpsUploader, uploadAttachment } from './upload.ts';

/** Per file; the whole file is held in memory while it is encrypted. */
export const SIGNAL_MAX_FILE_BYTES = 64_000_000;
/** How many files one message carries. */
export const SIGNAL_MAX_FILES = 10;

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
  content: { dataMessage: 1, syncMessage: 2, editMessage: 11 },
  data: { body: 1, attachments: 2, quote: 8, timestamp: 7, reaction: 16, delete: 17 },
  /** `AttachmentPointer`; the CDN key and number are the current form, `cdnId` the legacy one. */
  attachment: { contentType: 2, key: 3, size: 4, digest: 6, fileName: 7, cdnNumber: 14, cdnKey: 15 },
  /** `EditMessage`: the sent timestamp of the message being replaced, and its new `DataMessage`. */
  edit: { targetSentTimestamp: 1, dataMessage: 2 },
  /** `DataMessage.Delete`: the sent timestamp of the message being deleted for everyone. */
  delete: { targetSentTimestamp: 1 },
  /** `DataMessage.Quote`; the author goes out in both forms, like the destination of a transcript. */
  quote: { id: 1, authorAci: 5, authorAciBinary: 8 },
  /** `DataMessage.Reaction`; the target author goes out in both forms, like a quote's. */
  reaction: { emoji: 1, remove: 2, targetAuthorAci: 4, targetSentTimestamp: 5, targetAuthorAciBinary: 6 },
  sync: { sent: 1 },
  sent: {
    timestamp: 2,
    message: 3,
    editMessage: 10,
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
  /** Puts an encrypted attachment on the CDN — a test plays the CDN. Real HTTPS by default. */
  upload?: AttachmentUploader;
  onClose: () => Promise<void>;
  /**
   * Run one whole send — encrypt, PUT, flush — with the protocol store to itself.
   *
   * The direct path opens the session file for the send alone and needs nothing here. A send on a
   * LIVE receive session (`backend.ts`, `DeliverySession.openSender`) shares the store with the
   * receiver, and passes its queue: the fence belongs around the send as a whole, so it sits here
   * rather than at one call site, where the next method added would walk straight past it.
   */
  exclusive?: <T>(send: () => Promise<T>) => Promise<T>;
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
  readonly features: SenderFeatures = {
    markdown: false,
    attachments: true,
    replies: true,
    reactions: true,
    edits: true,
    deletes: true,
  };
  private readonly lib: SignalLib;
  private readonly store: SignalProtocolStore;
  private readonly account: DeviceAccount;
  private readonly fetch: ChatFetch;
  private readonly upload: AttachmentUploader;
  private readonly permit: SendPermit;
  private readonly onClose: () => Promise<void>;
  private readonly exclusive: <T>(send: () => Promise<T>) => Promise<T>;

  constructor(session: SignalSendSession, permit: SendPermit) {
    this.lib = session.lib;
    this.store = session.store;
    this.account = session.account;
    this.fetch = session.fetch;
    this.upload = session.upload ?? httpsUploader();
    this.permit = permit;
    this.onClose = session.onClose;
    this.exclusive = session.exclusive ?? ((send) => send());
  }

  send(message: SendingMessage): Promise<SentMessage> {
    return this.exclusive(() => this.sendNow(message));
  }

  react(reaction: SendingReaction): Promise<void> {
    return this.exclusive(() => this.reactNow(reaction));
  }

  edit(edit: SendingEdit): Promise<void> {
    return this.exclusive(() => this.editNow(edit));
  }

  delete(deletion: SendingDeletion): Promise<void> {
    return this.exclusive(() => this.deleteNow(deletion));
  }

  /** The sent timestamp of a message of the person's own, or a refusal before anything is sent. */
  private ownTimestamp(target: ReplyTarget): number {
    const { authorAci, sentTimestamp } = parseMessageRemoteId(target.remoteId);
    if (target.fromSelf !== true || authorAci !== this.account.aci) {
      throw new Error(_('only your own messages can be changed — nothing was sent'));
    }
    return sentTimestamp;
  }

  /** An `EditMessage`: the new text under a timestamp of its own, naming the message it replaces. */
  private async editNow(edit: SendingEdit): Promise<void> {
    const aci = this.recipient(edit.to);
    const target = this.ownTimestamp(edit.target);
    const bytes = UTF8.encode(edit.text).length;
    if (bytes > SIGNAL_MAX_MESSAGE_BYTES) {
      throw new Error(
        fmt(_('a Signal message holds at most {max} bytes of text, this one has {bytes} — shorten it'), {
          max: String(SIGNAL_MAX_MESSAGE_BYTES),
          bytes: String(bytes),
        }),
      );
    }
    const timestamp = Date.now();
    const dataMessage = new ProtoWriter().string(F.data.body, edit.text).uint(F.data.timestamp, timestamp);
    await this.transmit(aci, dataMessage, timestamp, target);
  }

  /** A `DataMessage` whose `delete` names the message taken back for everyone. */
  private async deleteNow(deletion: SendingDeletion): Promise<void> {
    const aci = this.recipient(deletion.to);
    const target = this.ownTimestamp(deletion.target);
    const timestamp = Date.now();
    const dataMessage = new ProtoWriter()
      .uint(F.data.timestamp, timestamp)
      .message(F.data.delete, new ProtoWriter().uint(F.delete.targetSentTimestamp, target));
    await this.transmit(aci, dataMessage, timestamp);
  }

  private async reactNow(reaction: SendingReaction): Promise<void> {
    const aci = this.recipient(reaction.to);
    const emoji = reaction.emoji ?? reaction.previous;
    if (emoji === undefined) {
      throw new Error(_('Signal needs the emoji being taken back — nothing was sent'));
    }
    const target = parseMessageRemoteId(reaction.target.remoteId);
    const timestamp = Date.now();
    const dataMessage = new ProtoWriter()
      .uint(F.data.timestamp, timestamp)
      .message(
        F.data.reaction,
        new ProtoWriter()
          .string(F.reaction.emoji, emoji)
          .bool(F.reaction.remove, reaction.emoji === null ? true : null)
          .string(F.reaction.targetAuthorAci, target.authorAci)
          .uint(F.reaction.targetSentTimestamp, target.sentTimestamp)
          .bytes(F.reaction.targetAuthorAciBinary, uuidToBytes(target.authorAci)),
      );
    await this.transmit(aci, dataMessage, timestamp);
  }

  private async sendNow(message: SendingMessage): Promise<SentMessage> {
    const aci = this.recipient(message.to);
    const files = inspectSendFiles(message.attachments ?? [], {
      perFile: SIGNAL_MAX_FILE_BYTES,
      count: SIGNAL_MAX_FILES,
    });
    const bytes = UTF8.encode(message.text).length;
    if (bytes > SIGNAL_MAX_MESSAGE_BYTES) {
      throw new Error(
        fmt(_('a Signal message holds at most {max} bytes of text, this one has {bytes} — shorten it'), {
          max: String(SIGNAL_MAX_MESSAGE_BYTES),
          bytes: String(bytes),
        }),
      );
    }
    // Every file is uploaded before anything is sent, so a failed upload means nothing went out.
    const pointers: ProtoWriter[] = [];
    for (const file of files) {
      const uploaded = await uploadAttachment(
        readFileSync(file.realPath),
        this.account,
        this.fetch,
        this.upload,
      );
      pointers.push(
        new ProtoWriter()
          .string(F.attachment.contentType, file.contentType)
          .bytes(F.attachment.key, uploaded.key)
          .uint(F.attachment.size, uploaded.size)
          .bytes(F.attachment.digest, uploaded.digest)
          .string(F.attachment.fileName, file.filename)
          .uint(F.attachment.cdnNumber, uploaded.cdnNumber)
          .string(F.attachment.cdnKey, uploaded.cdnKey),
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
    for (const pointer of pointers) dataMessage.message(F.data.attachments, pointer);
    if (message.replyTo) {
      const quoted = parseMessageRemoteId(message.replyTo.remoteId);
      dataMessage.message(
        F.data.quote,
        new ProtoWriter()
          .uint(F.quote.id, quoted.sentTimestamp)
          .string(F.quote.authorAci, quoted.authorAci)
          .bytes(F.quote.authorAciBinary, uuidToBytes(quoted.authorAci)),
      );
    }

    const warning = await this.transmit(aci, dataMessage, timestamp);

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

  /**
   * Deliver one `DataMessage` to the recipient and, as a transcript, to this account's other
   * devices. Returns the gap in a sentence when the recipient has it but the transcript failed.
   *
   * With `editOf`, the message goes out as an `EditMessage` replacing the one sent at that
   * timestamp, in the copies (`Content`) and in the transcript (`Sent`) alike.
   */
  private async transmit(
    aci: string,
    dataMessage: ProtoWriter,
    timestamp: number,
    editOf?: number,
  ): Promise<string | undefined> {
    const own = aci === this.account.aci;
    const edit =
      editOf === undefined
        ? undefined
        : new ProtoWriter()
            .uint(F.edit.targetSentTimestamp, editOf)
            .message(F.edit.dataMessage, dataMessage);
    // The recipient first: a transcript on the phone for a message the recipient never got would
    // show the user something that does not exist.
    if (!own) {
      const content = new ProtoWriter()
        .message(edit ? F.content.editMessage : F.content.dataMessage, edit ?? dataMessage)
        .finish();
      await this.deliver(aci, content, timestamp);
    }

    const sent = new ProtoWriter()
      .uint(F.sent.timestamp, timestamp)
      .message(edit ? F.sent.editMessage : F.sent.message, edit ?? dataMessage)
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
    return warning;
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
