/**
 * Our half of the OMEMO fixtures: drive `@curlew/omemo` as the initiator and dump what it emits.
 *
 * `generate.py` runs this between its `record` and `replay` phases. It is a separate program
 * rather than part of the test suite because python has to be the one that judges the output —
 * a test comparing our bytes against our own parser proves nothing about the wire format.
 *
 * Determinism is the whole trick. The session draws every random byte from `ourRandom` in the
 * recorded fixture instead of the system CSPRNG, so rerunning `generate.py` produces the same
 * file rather than an unreviewable diff. Nothing here is reachable from the app — it is a
 * tooling script, built on demand and never bundled.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import {
  Session,
  decodeKeyExchange,
  encryptPayload,
  fromBase64,
  keyPairFromPrivate,
  selectBundleKeys,
  signPreKey,
  toBase64,
  type DeviceBundle,
  type RandomSource,
} from '@curlew/omemo';

/** The parts of `legacy-peer-to-us.json` this program reads. */
interface Recorded {
  readonly us: {
    readonly identityKey: { readonly private: string };
    readonly signedPreKey: { readonly private: string; readonly public: string };
  };
  readonly ourRandom: string;
  readonly peer: {
    readonly bundle: {
      readonly identityKey: string;
      readonly signedPreKeyId: number;
      readonly signedPreKey: string;
      readonly signedPreKeySignature: string;
      readonly preKeys: readonly { readonly id: number; readonly publicKey: string }[];
    };
  };
}

/** Messages we send after the one that carries the key exchange. */
const FOLLOW_UPS = 3;

/**
 * A `RandomSource` that reads a recorded byte stream instead of the CSPRNG.
 *
 * Running out is a hard error and not a wrap-around: silently reusing bytes would hand the same
 * ephemeral key to two different agreements, which is the one thing a random source must never
 * do — and a fixture that did it would teach the tests that it is fine.
 */
function recordedRandom(bytes: Uint8Array): RandomSource {
  let offset = 0;
  return (out) => {
    if (offset + out.length > bytes.length) {
      throw new Error(`recorded randomness exhausted after ${String(offset)} bytes; raise OUR_RANDOM_BYTES`);
    }
    out.set(bytes.subarray(offset, offset + out.length));
    offset += out.length;
    return out;
  };
}

function toBundle(recorded: Recorded['peer']['bundle']): DeviceBundle {
  return {
    identityKey: fromBase64(recorded.identityKey),
    signedPreKeyId: recorded.signedPreKeyId,
    signedPreKey: fromBase64(recorded.signedPreKey),
    signedPreKeySignature: fromBase64(recorded.signedPreKeySignature),
    preKeys: recorded.preKeys.map((preKey) => ({ id: preKey.id, publicKey: fromBase64(preKey.publicKey) })),
  };
}

async function main(): Promise<void> {
  const [, , inputPath, outputPath] = process.argv;
  if (inputPath === undefined || outputPath === undefined) {
    throw new Error('usage: emit.js <legacy-peer-to-us.json> <output.json>');
  }

  const recorded = JSON.parse(readFileSync(inputPath, 'utf8')) as Recorded;
  const random = recordedRandom(fromBase64(recorded.ourRandom));
  const identityKey = keyPairFromPrivate(fromBase64(recorded.us.identityKey.private));

  const bundleKeys = selectBundleKeys(toBundle(recorded.peer.bundle), random);
  const session = await Session.initiate(identityKey, bundleKeys, { random });

  const payloads: { ciphertext: string; iv: string }[] = [];
  const messages: string[] = [];
  let keyExchange = '';

  for (let index = 0; index <= FOLLOW_UPS; index++) {
    const plaintext = `Nachricht ${String(index + 1)} von Bob.`;
    const payload = await encryptPayload(new TextEncoder().encode(plaintext), random);
    payloads.push({ ciphertext: toBase64(payload.ciphertext), iv: toBase64(payload.iv) });

    const outgoing = await session.encrypt(payload.keyMaterial);
    // Every message is wrapped while the exchange is unanswered, and in a real client the stanza
    // layer unwraps on arrival. Here the peer is already past that, so the follow-ups go over as
    // the bare authenticated message they contain.
    if (index === 0) {
      keyExchange = toBase64(outgoing.bytes);
    } else {
      messages.push(toBase64(decodeKeyExchange(outgoing.bytes).message));
    }
  }

  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        keyExchange,
        messages,
        payloads,
        signature: {
          identityKey: toBase64(identityKey.publicKey),
          signedPreKey: recorded.us.signedPreKey.public,
          signature: toBase64(
            signPreKey(identityKey.privateKey, fromBase64(recorded.us.signedPreKey.public), random),
          ),
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

await main();
