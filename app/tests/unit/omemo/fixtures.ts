/**
 * Loader for the recorded OMEMO fixtures, shared by every suite in this directory.
 *
 * The files are read from disk at run time rather than imported. A bundled `import` of JSON is
 * not something this repo does anywhere, and it would be the wrong trade here anyway: the point
 * of the fixtures is that `app/tests/fixtures/omemo/generate.py` can rewrite them from
 * python-oldmemo and the tests pick that up, which only works if the tests read the same files
 * the script writes. Their provenance is in the README next to them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { fromBase64, keyPairFromPrivate, type KeyPair, type RandomSource } from '@curlew/omemo';

const PEER_TO_US_REL = join('app', 'tests', 'fixtures', 'omemo', 'legacy-peer-to-us.json');
const US_TO_PEER_REL = join('app', 'tests', 'fixtures', 'omemo', 'legacy-us-to-peer.json');

/** One message as `message_json` in `generate.py` records it. */
export interface RecordedMessage {
  readonly plaintext: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly keyMaterial: string;
  readonly message: string;
  readonly keyExchange?: string;
}

/** `legacy-peer-to-us.json`: python-oldmemo as Alice, talking to us. */
export interface PeerToUs {
  readonly namespace: string;
  readonly us: {
    readonly jid: string;
    readonly deviceId: number;
    readonly identityKey: { readonly private: string; readonly public: string };
    readonly signedPreKey: {
      readonly id: number;
      readonly private: string;
      readonly public: string;
      readonly signature: string;
    };
    readonly preKeys: readonly { readonly id: number; readonly private: string; readonly public: string }[];
  };
  readonly ourRandom: string;
  readonly peer: {
    readonly jid: string;
    readonly deviceId: number;
    readonly bundle: {
      readonly identityKey: string;
      readonly signedPreKeyId: number;
      readonly signedPreKey: string;
      readonly signedPreKeySignature: string;
      readonly preKeys: readonly { readonly id: number; readonly publicKey: string }[];
    };
  };
  readonly peerToUs: {
    readonly keyExchange: RecordedMessage & { readonly keyExchange: string };
    readonly messages: readonly RecordedMessage[];
    readonly skipAhead: RecordedMessage & { readonly index: number };
  };
}

/** `legacy-us-to-peer.json`: what python-oldmemo made of our output. */
export interface UsToPeer {
  readonly namespace: string;
  readonly usToPeer: {
    readonly keyExchange: string;
    readonly messages: readonly string[];
    readonly payloads: readonly { readonly ciphertext: string; readonly iv: string }[];
    readonly decrypted: readonly string[];
  };
  readonly signatureAccepted: boolean;
  readonly peerReplies: readonly RecordedMessage[];
}

/**
 * The repo root, found by walking up from the working directory until the fixtures are there.
 *
 * Not derived from `import.meta.url`: this suite is BUNDLED into `app/dist/test.gjs.mjs`, so that
 * URL names the bundle rather than this file, and a path built from it points at the wrong tree.
 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, PEER_TO_US_REL))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`${PEER_TO_US_REL} not found above ${process.cwd()} — run this suite inside the checkout`);
}

function load<T>(relative: string): T {
  return JSON.parse(readFileSync(join(repoRoot(), relative), 'utf8')) as T;
}

let peerToUs: PeerToUs | undefined;
let usToPeer: UsToPeer | undefined;

/** The recorded session where python-oldmemo is the initiator. */
export function loadPeerToUs(): PeerToUs {
  return (peerToUs ??= load<PeerToUs>(PEER_TO_US_REL));
}

/** The recorded session where our code is the initiator. */
export function loadUsToPeer(): UsToPeer {
  return (usToPeer ??= load<UsToPeer>(US_TO_PEER_REL));
}

/** Our own key material from the fixture, as the package's own types. */
export function ourKeys(fixture: PeerToUs = loadPeerToUs()): {
  identityKey: KeyPair;
  signedPreKey: KeyPair & { id: number; signature: Uint8Array };
  preKeys: (KeyPair & { id: number })[];
} {
  const signedPreKey = {
    id: fixture.us.signedPreKey.id,
    ...keyPairFromPrivate(fromBase64(fixture.us.signedPreKey.private)),
    signature: fromBase64(fixture.us.signedPreKey.signature),
  };
  return {
    identityKey: keyPairFromPrivate(fromBase64(fixture.us.identityKey.private)),
    signedPreKey,
    preKeys: fixture.us.preKeys.map((preKey) => ({
      id: preKey.id,
      ...keyPairFromPrivate(fromBase64(preKey.private)),
    })),
  };
}

/** The peer's published bundle, decoded. */
export function peerBundle(fixture: PeerToUs = loadPeerToUs()) {
  const bundle = fixture.peer.bundle;
  return {
    identityKey: fromBase64(bundle.identityKey),
    signedPreKeyId: bundle.signedPreKeyId,
    signedPreKey: fromBase64(bundle.signedPreKey),
    signedPreKeySignature: fromBase64(bundle.signedPreKeySignature),
    preKeys: bundle.preKeys.map((preKey) => ({ id: preKey.id, publicKey: fromBase64(preKey.publicKey) })),
  };
}

/**
 * A `RandomSource` that replays the recorded stream, so our side reproduces the recorded bytes.
 *
 * Running past the end throws rather than wrapping. Reusing the stream would hand the same
 * ephemeral key to two agreements — the one thing a random source must never do — and a fixture
 * that quietly did it would teach these tests that it is acceptable.
 */
export function recordedRandom(fixture: PeerToUs = loadPeerToUs()): RandomSource {
  const bytes = fromBase64(fixture.ourRandom);
  let offset = 0;
  return (out) => {
    if (offset + out.length > bytes.length) {
      throw new Error(`recorded randomness exhausted after ${String(offset)} bytes`);
    }
    out.set(bytes.subarray(offset, offset + out.length));
    offset += out.length;
    return out;
  };
}

/** Decode a base64 field from a fixture. */
export function bytes(base64: string): Uint8Array {
  return fromBase64(base64);
}
