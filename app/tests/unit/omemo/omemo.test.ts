import { describe, expect, it } from '@gjsify/unit';

import {
  Session,
  buildBundle,
  generateKeyPair,
  generatePreKeys,
  generateSignedPreKey,
  decodeKeyExchange,
  decryptPayload,
  encryptPayload,
  isAuthenticationFailedError,
  isDuplicateMessageError,
  isSkippedKeyLimitError,
  selectBundleKeys,
  toBase64,
  type AcceptKeys,
  type SessionOptions,
} from '@curlew/omemo';

import {
  bytes,
  loadPeerToUs,
  loadUsToPeer,
  ourKeys,
  peerBundle,
  recordedRandom,
  type RecordedMessage,
} from './fixtures.ts';

const text = new TextDecoder();
const encode = new TextEncoder();

/** Everything a peer→us message decrypts to, checked against the plaintext the recorder wrote. */
async function expectPlaintext(message: RecordedMessage, keyMaterial: Uint8Array): Promise<void> {
  expect(toBase64(keyMaterial)).toBe(message.keyMaterial);
  const plaintext = await decryptPayload(bytes(message.ciphertext), bytes(message.iv), keyMaterial);
  expect(text.decode(plaintext)).toBe(message.plaintext);
}

/** A session accepted from the recorded key exchange, plus the key material of that first message. */
async function acceptRecorded(options: SessionOptions = {}) {
  const fixture = loadPeerToUs();
  const keys = ourKeys(fixture);
  const exchange = decodeKeyExchange(bytes(fixture.peerToUs.keyExchange.keyExchange));
  const preKey = keys.preKeys.find((candidate) => candidate.id === exchange.preKeyId);
  if (preKey === undefined) throw new Error('the recorded exchange names a prekey the fixture does not hold');
  const accept: AcceptKeys = { identityKey: keys.identityKey, signedPreKey: keys.signedPreKey, preKey };
  return { fixture, keys, exchange, accept, ...(await Session.accept(accept, exchange, options)) };
}

/** Our initiating session as `emit.ts` builds it, drawing from the recorded random stream. */
async function initiateRecorded() {
  const fixture = loadPeerToUs();
  const random = recordedRandom(fixture);
  const identityKey = ourKeys(fixture).identityKey;
  const bundleKeys = selectBundleKeys(peerBundle(fixture), random);
  const session = await Session.initiate(identityKey, bundleKeys, { random });
  return { fixture, random, session };
}

// Every byte sequence read here was produced or accepted by python-oldmemo (see the fixtures'
// README), so these suites check the wire format against a second implementation. Not covered, on
// purpose: anything that would need bytes python never saw — a replayed key exchange on a fresh
// session, a stale signed prekey, 16-byte-IV payloads — has no fixture to stand on.
export default async () => {
  await describe('omemo: peer → us (recorded from python-oldmemo)', async () => {
    await it('accepts the key exchange and decrypts its message', async () => {
      const { fixture, keyMaterial, session } = await acceptRecorded();
      await expectPlaintext(fixture.peerToUs.keyExchange, keyMaterial);
      expect(session.toRecord().pendingKeyExchange).toBe(undefined);
    });

    await it('decrypts the follow-ups in order', async () => {
      const { fixture, session } = await acceptRecorded();
      for (const message of fixture.peerToUs.messages) {
        await expectPlaintext(message, await session.decrypt(bytes(message.message)));
      }
    });

    await it('decrypts the follow-ups out of order via skipped keys', async () => {
      const { fixture, session } = await acceptRecorded();
      const { skipAhead, messages } = fixture.peerToUs;
      await expectPlaintext(skipAhead, await session.decrypt(bytes(skipAhead.message)));
      for (const message of [...messages].reverse()) {
        await expectPlaintext(message, await session.decrypt(bytes(message.message)));
      }
    });

    await it('rejects a replayed message', async () => {
      const { fixture, session } = await acceptRecorded();
      const first = fixture.peerToUs.messages[0]!;
      await session.decrypt(bytes(first.message));
      let thrown: unknown;
      try {
        await session.decrypt(bytes(first.message));
      } catch (err) {
        thrown = err;
      }
      expect(isDuplicateMessageError(thrown)).toBe(true);
    });

    await it('rejects a message that skips past the limit and keeps the session usable', async () => {
      const { fixture, session } = await acceptRecorded({
        limits: { maxSkippedKeysPerMessage: 3, maxSkippedKeysPerSession: 3 },
      });
      const { skipAhead, messages } = fixture.peerToUs;
      let thrown: unknown;
      try {
        await session.decrypt(bytes(skipAhead.message));
      } catch (err) {
        thrown = err;
      }
      expect(isSkippedKeyLimitError(thrown)).toBe(true);
      await expectPlaintext(messages[0]!, await session.decrypt(bytes(messages[0]!.message)));
    });

    await it('fails authentication on a tampered message', async () => {
      const { fixture, session } = await acceptRecorded();
      const tampered = bytes(fixture.peerToUs.messages[0]!.message);
      tampered[tampered.length - 1]! ^= 0x01;
      let thrown: unknown;
      try {
        await session.decrypt(tampered);
      } catch (err) {
        thrown = err;
      }
      expect(isAuthenticationFailedError(thrown)).toBe(true);
    });

    await it('fails with the wrong identity key', async () => {
      const { exchange, accept } = await acceptRecorded();
      let thrown: unknown;
      try {
        await Session.accept({ ...accept, identityKey: generateKeyPair() }, exchange);
      } catch (err) {
        thrown = err;
      }
      expect(isAuthenticationFailedError(thrown)).toBe(true);
    });
  });

  await describe('omemo: us → peer (accepted by python-oldmemo)', async () => {
    await it('reproduces the recorded key exchange and follow-ups byte for byte', async () => {
      const { random, session } = await initiateRecorded();
      const recorded = loadUsToPeer();
      expect(recorded.signatureAccepted).toBe(true);

      for (let index = 0; index < recorded.usToPeer.payloads.length; index++) {
        const plaintext = `Nachricht ${String(index + 1)} von Bob.`;
        expect(recorded.usToPeer.decrypted[index]).toBe(plaintext);
        const payload = await encryptPayload(encode.encode(plaintext), random);
        expect(toBase64(payload.ciphertext)).toBe(recorded.usToPeer.payloads[index]!.ciphertext);
        expect(toBase64(payload.iv)).toBe(recorded.usToPeer.payloads[index]!.iv);

        const outgoing = await session.encrypt(payload.keyMaterial);
        if (index === 0) {
          expect(outgoing.kind).toBe('key-exchange');
          expect(toBase64(outgoing.bytes)).toBe(recorded.usToPeer.keyExchange);
        } else {
          expect(toBase64(decodeKeyExchange(outgoing.bytes).message)).toBe(
            recorded.usToPeer.messages[index - 1]!,
          );
        }
      }
    });

    await it("decrypts the peer's replies through a Diffie-Hellman step and drops the pending exchange", async () => {
      const { random, session } = await initiateRecorded();
      const first = await encryptPayload(encode.encode('x'), random);
      await session.encrypt(first.keyMaterial);
      expect(session.toRecord().pendingKeyExchange === undefined).toBe(false);

      for (const reply of loadUsToPeer().peerReplies) {
        await expectPlaintext(reply, await session.decrypt(bytes(reply.message)));
      }
      expect(session.toRecord().pendingKeyExchange).toBe(undefined);
    });
  });

  await describe('omemo: both directions without a fixture', async () => {
    await it('establishes a session in each direction between two of our own devices', async () => {
      for (const initiatorFirst of [true, false]) {
        const aliceIdentity = generateKeyPair();
        const bobIdentity = generateKeyPair();
        const [initiatorIdentity, responderIdentity] = initiatorFirst
          ? [aliceIdentity, bobIdentity]
          : [bobIdentity, aliceIdentity];
        const signedPreKey = generateSignedPreKey(responderIdentity, 1);
        const [preKey] = generatePreKeys(7, 1);
        const bundle = buildBundle(responderIdentity, signedPreKey, [preKey!]);

        const initiator = await Session.initiate(initiatorIdentity, selectBundleKeys(bundle));
        const hello = await encryptPayload(encode.encode('hallo'));
        const first = await initiator.encrypt(hello.keyMaterial);
        expect(first.kind).toBe('key-exchange');

        const accepted = await Session.accept(
          { identityKey: responderIdentity, signedPreKey, preKey: preKey! },
          decodeKeyExchange(first.bytes),
        );
        expect(toBase64(accepted.keyMaterial)).toBe(toBase64(hello.keyMaterial));

        const answer = await encryptPayload(encode.encode('servus'));
        const reply = await accepted.session.encrypt(answer.keyMaterial);
        expect(reply.kind).toBe('message');
        expect(toBase64(await initiator.decrypt(reply.bytes))).toBe(toBase64(answer.keyMaterial));
        expect(initiator.toRecord().pendingKeyExchange).toBe(undefined);
      }
    });
  });
};
