/**
 * One envelope → the sender and the decrypted `Content`.
 *
 * Ported from Signal-Desktop `ts/textsecure/MessageReceiver.preload.ts` — `#unsealEnvelope`,
 * `#validateUnsealedEnvelope`, `#decryptSealedSender`, `#innerDecrypt`, `#unpad` (Copyright
 * 2020-2026 Signal Messenger, LLC, AGPL-3.0-only). The cryptography is libsignal's; what is here
 * is the dispatch by envelope type, the sender-certificate check and the rules a receiver keeps:
 *
 * - sealed sender: open the outer layer with the identity key, check the sender certificate
 *   against Signal's trust roots at the SERVER's timestamp, then decrypt the inner message by its
 *   type (pre-key, whisper, sender key); a plaintext inner message is a peer's retry request;
 * - a message to our PNI (someone who knows only the phone number) cannot be read — this device
 *   was linked without PNI keys (`nopni`), as Signal-Desktop links;
 * - a sender-key distribution message riding in the content is processed at once: the group
 *   messages that follow need it;
 * - a message this device already decrypted (the server redelivered what was decrypted but not
 *   acknowledged before a crash) is `duplicate`, and only acknowledged.
 */

import type * as Core from '@signalapp/libsignal-client';
import type { SignalLib } from './lib.ts';
import type { SignalProtocolStore } from './protocol-store.ts';
import { type Content, decodeContent, type Envelope, EnvelopeType, unpadPlaintext } from './schema.ts';

export type DecryptResult =
  | {
      kind: 'content';
      senderAci: string;
      senderDevice: number;
      /** The decrypted, unpadded plaintext — kept raw when it cannot be parsed or mapped. */
      plaintext: Uint8Array;
      /** The parsed content; null when the plaintext did not parse (see `parseError`). */
      content: Content | null;
      parseError: string | null;
      /** Sealed sender: for a sender-key message, the group it was sent to. */
      groupId: Uint8Array | null;
      /** Contacts whose identity key (safety number) changed while decrypting this envelope. */
      identityChanged: string[];
    }
  /** Already decrypted in an earlier, unacknowledged run. */
  | { kind: 'duplicate' }
  /**
   * Nothing to read, and no envelope worth keeping.
   *
   * The reason is a name, not a sentence: a run has to be able to say "three envelopes arrived and
   * were dropped" by counting, and every reason here used to be an English phrase that nothing in
   * the codebase read — so a run could not tell "nothing arrived" from "it arrived unread".
   */
  | { kind: 'skip'; reason: SkipReason; detail: string };

/**
 * Why an envelope was deliberately not turned into a message.
 *
 * Delivery to a linked device is at most once: the receiver acknowledges every envelope it
 * processed, including the ones it could not read. So each of these is potentially a message the
 * user will never see here — and only one of them is expected traffic.
 */
export type SkipReason =
  /** The network confirming it handed over something. Never was a message. */
  | 'server-receipt'
  /**
   * Addressed to the phone-number identity. A linked device is registered under the account
   * identity and holds no key for the phone-number one, so postbote cannot read these at all.
   * Whether the server means to deliver them here is unknown; that it acknowledged them is not.
   */
  | 'phone-number-identity'
  /** No ciphertext on the envelope. */
  | 'no-content'
  /** The network asking this device to resend its queue — a request, not a message. */
  | 'retry-request'
  /** This device sent it; its own echo must not become a second copy. */
  | 'own-echo';

export interface DecryptorOptions {
  /** Signal's sealed-sender trust roots, as serialized public keys. */
  trustRoots: readonly Uint8Array[];
}

export class EnvelopeDecryptor {
  private readonly lib: SignalLib;
  private readonly store: SignalProtocolStore;
  private readonly trustRoots: Core.PublicKey[];
  private readonly aci: string;
  private readonly deviceId: number;

  constructor(lib: SignalLib, store: SignalProtocolStore, options: DecryptorOptions) {
    const account = store.account();
    if (!account) throw new Error('the Signal session is not linked');
    this.lib = lib;
    this.store = store;
    this.aci = account.aci;
    this.deviceId = account.deviceId;
    this.trustRoots = options.trustRoots.map((k) =>
      lib.core.PublicKey.deserialize(k as Uint8Array<ArrayBuffer>),
    );
  }

  async decrypt(envelope: Envelope): Promise<DecryptResult> {
    // Drop what a failed attempt left behind: a key change belongs to the envelope that caused
    // it, never to whatever comes next.
    this.store.takeIdentityChanges();
    try {
      const result = await this.decryptInner(envelope);
      if (result.kind === 'content')
        result.identityChanged = this.store.takeIdentityChanges().map((c) => c.aci);
      return result;
    } catch (err) {
      if (
        err instanceof this.lib.core.LibSignalErrorBase &&
        err.code === this.lib.core.ErrorCode.DuplicatedMessage
      ) {
        return { kind: 'duplicate' };
      }
      throw err;
    }
  }

  private get local(): Core.ProtocolAddress {
    return this.lib.core.ProtocolAddress.new(this.aci, this.deviceId);
  }

  private async decryptInner(envelope: Envelope): Promise<DecryptResult> {
    const S = this.lib.core;
    if (envelope.type === EnvelopeType.SERVER_DELIVERY_RECEIPT)
      return { kind: 'skip', reason: 'server-receipt', detail: 'server receipt' };
    if (envelope.destinationServiceId && envelope.destinationServiceId !== this.aci) {
      return {
          kind: 'skip',
          reason: 'phone-number-identity',
          detail: 'addressed to the phone number identity (PNI)',
        };
    }
    const ciphertext = envelope.content as Uint8Array<ArrayBuffer> | null;
    if (!ciphertext) return { kind: 'skip', reason: 'no-content', detail: 'no content' };
    const st = this.store;

    if (envelope.type === EnvelopeType.PLAINTEXT_CONTENT) {
      return { kind: 'skip', reason: 'retry-request', detail: 'plaintext resend request' };
    }

    if (envelope.type === EnvelopeType.UNIDENTIFIED_SENDER) {
      const usmc = await S.sealedSenderDecryptToUsmc(ciphertext, st.identities);
      const certificate = usmc.senderCertificate();
      const senderAci = certificate.senderUuid().toLowerCase();
      const senderDevice = certificate.senderDeviceId();
      if (senderAci === this.aci && senderDevice === this.deviceId) {
        return { kind: 'skip', reason: 'own-echo', detail: 'sent by this device' };
      }
      const serverTimestamp = envelope.serverTimestamp ?? 0;
      if (serverTimestamp <= 0) throw new Error('sealed-sender envelope without a server timestamp');
      if (!certificate.validateWithTrustRoots(this.trustRoots, serverTimestamp)) {
        throw new Error("the sender certificate did not validate against Signal's trust roots");
      }
      const sender = S.ProtocolAddress.new(senderAci, senderDevice);
      const contents = usmc.contents();
      let padded: Uint8Array;
      switch (usmc.msgType()) {
        case S.CiphertextMessageType.Plaintext:
          return { kind: 'skip', reason: 'retry-request', detail: 'retry request' };
        case S.CiphertextMessageType.SenderKey:
          padded = await S.groupDecrypt(sender, st.senderKeys, contents);
          break;
        case S.CiphertextMessageType.PreKey:
          padded = await S.signalDecryptPreKey(
            S.PreKeySignalMessage.deserialize(contents),
            sender,
            this.local,
            st.sessions,
            st.identities,
            st.preKeys,
            st.signedPreKeys,
            st.kyberPreKeys,
          );
          break;
        case S.CiphertextMessageType.Whisper:
          padded = await S.signalDecrypt(
            S.SignalMessage.deserialize(contents),
            sender,
            this.local,
            st.sessions,
            st.identities,
          );
          break;
        default:
          throw new Error(`unknown sealed-sender message type ${usmc.msgType()}`);
      }
      return this.content(senderAci, senderDevice, padded, usmc.groupId());
    }

    const senderAci = envelope.sourceServiceId;
    const senderDevice = envelope.sourceDevice;
    if (!senderAci || senderAci.startsWith('PNI:') || !senderDevice) {
      throw new Error('envelope without a sender');
    }
    const sender = S.ProtocolAddress.new(senderAci, senderDevice);
    let padded: Uint8Array;
    if (envelope.type === EnvelopeType.DOUBLE_RATCHET) {
      padded = await S.signalDecrypt(
        S.SignalMessage.deserialize(ciphertext),
        sender,
        this.local,
        st.sessions,
        st.identities,
      );
    } else if (envelope.type === EnvelopeType.PREKEY_MESSAGE) {
      padded = await S.signalDecryptPreKey(
        S.PreKeySignalMessage.deserialize(ciphertext),
        sender,
        this.local,
        st.sessions,
        st.identities,
        st.preKeys,
        st.signedPreKeys,
        st.kyberPreKeys,
      );
    } else {
      throw new Error(`unknown envelope type ${envelope.type}`);
    }
    return this.content(senderAci, senderDevice, padded, null);
  }

  private async content(
    senderAci: string,
    senderDevice: number,
    padded: Uint8Array,
    groupId: Uint8Array | null,
  ): Promise<DecryptResult> {
    const S = this.lib.core;
    // Decrypted means the ratchet moved: from here on, nothing may throw the plaintext away.
    let plaintext: Uint8Array = padded;
    let content: Content | null = null;
    let parseError: string | null = null;
    try {
      plaintext = unpadPlaintext(padded);
      content = decodeContent(plaintext);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    if (content?.senderKeyDistribution) {
      await S.processSenderKeyDistributionMessage(
        S.ProtocolAddress.new(senderAci, senderDevice),
        S.SenderKeyDistributionMessage.deserialize(content.senderKeyDistribution as Uint8Array<ArrayBuffer>),
        this.store.senderKeys,
      );
    }
    return {
      kind: 'content',
      senderAci,
      senderDevice,
      plaintext,
      content,
      parseError,
      groupId,
      identityChanged: [],
    };
  }
}
