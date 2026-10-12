#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Record the OMEMO protocol fixtures in this directory from python-oldmemo.

The unit tests of ``@curlew/omemo`` must not check our implementation against itself — a wire
format we invent and then parse back is self-consistent no matter how wrong it is. So every byte
sequence in ``legacy-peer-to-us.json`` and ``legacy-us-to-peer.json`` was produced or accepted by
python-oldmemo, the reference implementation of ``eu.siacs.conversations.axolotl``, and this
script is the record of how.

Run it from the repository root::

    python3 -m venv .venv-omemo-fixtures
    .venv-omemo-fixtures/bin/pip install oldmemo
    .venv-omemo-fixtures/bin/python app/tests/fixtures/omemo/generate.py

There are three phases, and ``all`` (the default) runs them in order:

``record``
    python-oldmemo plays Alice, builds a session to a bundle we hand it, and emits the key
    exchange and a handful of follow-up messages. Everything our side needs to decrypt them —
    our private keys, Alice's bundle — goes into the fixture too.

``emit``
    builds and runs ``emit.ts``, which drives ``@curlew/omemo`` over the *other* direction: our
    code starts a session from Alice's recorded bundle and produces a key exchange of its own.

``replay``
    hands that to python-oldmemo, which decrypts it, confirms what it read, verifies the XEdDSA
    signature our code made, and answers — so the fixture also contains replies that make our
    ratchet take a Diffie-Hellman step.

Everything is deterministic, and it takes two separate measures. ``secrets.token_bytes`` and
``secrets.choice`` are replaced by a counter-based PRNG, reset per phase (:func:`seed_prng`), and
the whole run is forced onto a fixed hash seed (:func:`require_fixed_hash_seed`). Without both,
every regeneration would be an unreviewable diff — and worse, ``record`` and ``replay`` would
disagree about who Alice is. The keys and JIDs are synthetic: ``alice@example.org`` and
``bob@example.org``, from a fixed seed, never used anywhere else.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import secrets
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import x3dh
import xeddsa
from doubleratchet.recommended.diffie_hellman_ratchet_curve25519 import DiffieHellmanRatchet
from oldmemo.oldmemo import (
    BundleImpl,
    ContentImpl,
    EncryptedKeyMaterialImpl,
    KeyExchangeImpl,
    Oldmemo,
    PlainKeyMaterialImpl,
    StateImpl,
)
from omemo.storage import Just, Maybe, Nothing, Storage

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]

SEED = b"curlew omemo fixtures v1"

PEER_JID = "alice@example.org"
PEER_DEVICE_ID = 42
PEER_PRE_KEY_COUNT = 3

OUR_JID = "bob@example.org"
OUR_DEVICE_ID = 1337
OUR_SIGNED_PRE_KEY_ID = 7
OUR_PRE_KEY_IDS = (31, 32, 33)

# How many random bytes the TypeScript side gets to draw. Its RandomSource reads this stream
# instead of crypto.getRandomValues, so its output is as reproducible as python's.
OUR_RANDOM_BYTES = 512

# Messages Alice sends after the key exchange. Four is enough for out-of-order delivery (decrypt
# 4 before 1, 2, 3) with one left over to decrypt twice for the replay check.
PEER_FOLLOW_UPS = 4
# The sending-chain index of the extra message recorded for the skipped-key limit. The tests set
# a small limit rather than python's default of 1000, so a gap of ten is plenty.
PEER_SKIP_AHEAD_INDEX = 10


class Prng:
    """A counter-based stand-in for ``secrets``, so that a rerun produces the same fixtures."""

    def __init__(self, seed: bytes) -> None:
        self.__seed = seed
        self.__counter = 0

    def bytes(self, length: int) -> bytes:
        out = b""
        while len(out) < length:
            out += hashlib.sha256(self.__seed + self.__counter.to_bytes(8, "big")).digest()
            self.__counter += 1
        return out[:length]


def seed_prng() -> None:
    """Point ``secrets`` at a fresh :class:`Prng`, so a phase always starts from the same bytes.

    Every phase calls this, not just the first. ``record`` and ``replay`` have to build the same
    Alice out of the same seed, and in an ``all`` run they share one process — so without a reset
    in between, ``replay`` would continue the stream where ``record`` left off and talk to a
    stranger.
    """

    prng = Prng(SEED)
    secrets.token_bytes = prng.bytes  # type: ignore[assignment]
    secrets.choice = lambda population: sorted(population)[0]  # type: ignore[assignment]


def seed_ratchet_key_generation() -> None:
    """Route the Double Ratchet's own key generation through :func:`seed_prng` as well.

    python-doubleratchet draws its ratchet keys from ``X25519PrivateKey.generate()``, which goes
    straight to the system CSPRNG and never touches ``secrets`` — so without this every message in
    the fixtures carries a fresh ratchet public key and a regeneration rewrites every line.
    """

    DiffieHellmanRatchet._generate_priv = staticmethod(  # noqa: SLF001
        lambda: secrets.token_bytes(32)
    )


def require_fixed_hash_seed() -> None:
    """Re-exec with ``PYTHONHASHSEED=0`` unless it is already set.

    Seeding ``secrets`` is not enough to make python-omemo reproducible. It assigns pre key ids by
    walking ``state.bundle.pre_keys | state.hidden_pre_keys``, a frozenset of raw key bytes, and
    python randomizes ``hash(bytes)`` per process — so the SAME three keys get a different id each
    run. The fixture then names a pre key id whose public key belongs to another id, both sides
    compute a different DH4, and the key exchange fails to decrypt with nothing pointing at why.

    The variable is read once at interpreter start, so this has to happen by exec rather than by
    assignment.
    """

    if os.environ.get("PYTHONHASHSEED") != "0":
        os.execve(sys.executable, [sys.executable, *sys.argv], {**os.environ, "PYTHONHASHSEED": "0"})


class MemoryStorage(Storage):
    """python-omemo's key/value port, backed by a dict that dies with the process."""

    def __init__(self) -> None:
        super().__init__()
        self.__data: Dict[str, Any] = {}

    async def _load(self, key: str) -> Maybe[Any]:
        return Just(self.__data[key]) if key in self.__data else Nothing()

    async def _store(self, key: str, value: Any) -> None:
        self.__data[key] = value

    async def _delete(self, key: str) -> None:
        self.__data.pop(key, None)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def unb64(data: str) -> bytes:
    return base64.b64decode(data)


def clamp(key: bytes) -> bytes:
    """Clamp a Curve25519 scalar (RFC 7748 §5).

    libxeddsa clamps inside ``x25519`` and ``priv_to_curve25519_pub`` but *not* inside
    ``ed25519_priv_sign``, so an unclamped identity key would sign under one scalar and agree
    under another. Clamping every private key we generate here removes the question.
    """

    mutable = bytearray(key)
    mutable[0] &= 248
    mutable[31] &= 127
    mutable[31] |= 64
    return bytes(mutable)


class OurKeys:
    """The key material the TypeScript side owns, generated here so python can address it."""

    def __init__(self) -> None:
        self.identity_key = clamp(secrets.token_bytes(32))
        self.signed_pre_key = clamp(secrets.token_bytes(32))
        # Force the Ed25519 sign bit to 0 before signing. libxeddsa signs under whichever sign
        # the scalar happens to have, while XEdDSA proper — and `@gjsify/xeddsa` with it — always
        # negates to sign 0. Without this the two sides disagree about which Edwards point the
        # Curve25519 identity key means, and every signature check fails.
        self.signed_pre_key_signature = xeddsa.ed25519_priv_sign(
            xeddsa.priv_force_sign(self.identity_key, False),
            StateImpl.serialize_public_key(xeddsa.priv_to_curve25519_pub(self.signed_pre_key)),
            secrets.token_bytes(64),
        )
        self.pre_keys = {pre_key_id: clamp(secrets.token_bytes(32)) for pre_key_id in OUR_PRE_KEY_IDS}

    @property
    def identity_key_pub(self) -> bytes:
        return xeddsa.priv_to_curve25519_pub(self.identity_key)

    @property
    def signed_pre_key_pub(self) -> bytes:
        return xeddsa.priv_to_curve25519_pub(self.signed_pre_key)

    def bundle(self) -> BundleImpl:
        """Our bundle in the shape python-oldmemo expects.

        python-omemo carries identity keys in Ed25519 form and converts to Curve25519 only when
        serializing, so the bundle we hand it has to be converted the other way first. The sign
        bit is 0 because that is what XEdDSA signing forces, in libxeddsa as in `@gjsify/xeddsa`.
        """

        pre_key_pubs = {
            xeddsa.priv_to_curve25519_pub(priv): pre_key_id for pre_key_id, priv in self.pre_keys.items()
        }
        return BundleImpl(
            OUR_JID,
            OUR_DEVICE_ID,
            x3dh.Bundle(
                identity_key=xeddsa.curve25519_pub_to_ed25519_pub(self.identity_key_pub, False),
                signed_pre_key=self.signed_pre_key_pub,
                signed_pre_key_sig=self.signed_pre_key_signature,
                pre_keys=frozenset(pre_key_pubs),
            ),
            OUR_SIGNED_PRE_KEY_ID,
            pre_key_pubs,
        )

    def json(self) -> Dict[str, Any]:
        return {
            "jid": OUR_JID,
            "deviceId": OUR_DEVICE_ID,
            "identityKey": {"private": b64(self.identity_key), "public": b64(self.identity_key_pub)},
            "signedPreKey": {
                "id": OUR_SIGNED_PRE_KEY_ID,
                "private": b64(self.signed_pre_key),
                "public": b64(self.signed_pre_key_pub),
                "signature": b64(self.signed_pre_key_signature),
            },
            "preKeys": [
                {
                    "id": pre_key_id,
                    "private": b64(priv),
                    "public": b64(xeddsa.priv_to_curve25519_pub(priv)),
                }
                for pre_key_id, priv in self.pre_keys.items()
            ],
        }


def bundle_json(bundle: BundleImpl) -> Dict[str, Any]:
    """A python-oldmemo bundle as `DeviceBundle` — in exactly the shape PEP carries it.

    Two things happen on the way out, both from ``oldmemo.etree.serialize_bundle``. The identity
    key goes back to Curve25519, which drops its Ed25519 sign bit; and that sign bit is stashed in
    the top bit of the signature's last byte, where a verifier picks it up again. Recording the
    bundle without the second step would give our side a signature it cannot check.
    """

    signature = bytearray(bundle.bundle.signed_pre_key_sig)
    signature[63] |= bundle.bundle.identity_key[31] & 0x80

    return {
        "identityKey": b64(xeddsa.ed25519_pub_to_curve25519_pub(bundle.bundle.identity_key)),
        "signedPreKeyId": bundle.signed_pre_key_id,
        "signedPreKey": b64(bundle.bundle.signed_pre_key),
        "signedPreKeySignature": b64(bytes(signature)),
        "preKeys": [
            {"id": pre_key_id, "publicKey": b64(pre_key)}
            for pre_key, pre_key_id in sorted(bundle.pre_key_ids.items(), key=lambda item: item[1])
        ],
    }


async def setup() -> Tuple[OurKeys, bytes, Oldmemo, BundleImpl]:
    """Everything both phases need, drawn from the PRNG in a fixed order.

    ``record`` and ``replay`` run in separate processes and nothing is persisted between them, so
    the only thing that lets ``replay`` address the same Alice is starting from the same seed and
    drawing in the same order. Hence one function, called first by both.
    """

    our_keys = OurKeys()
    our_random = secrets.token_bytes(OUR_RANDOM_BYTES)
    peer = Oldmemo(MemoryStorage())
    await peer.generate_pre_keys(PEER_PRE_KEY_COUNT)
    return our_keys, our_random, peer, await peer.get_bundle(PEER_JID, PEER_DEVICE_ID)


def message_json(
    plaintext: bytes,
    content: Any,
    plain_key_material: PlainKeyMaterialImpl,
    authenticated_message: bytes,
    key_exchange: Optional[bytes] = None,
) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "plaintext": plaintext.decode("utf-8"),
        "ciphertext": b64(content.ciphertext),
        "iv": b64(content.initialization_vector),
        "keyMaterial": b64(plain_key_material.key + plain_key_material.auth_tag),
        "message": b64(authenticated_message),
    }
    if key_exchange is not None:
        out["keyExchange"] = b64(key_exchange)
    return out


async def record() -> Dict[str, Any]:
    """Alice starts a session with us and sends six messages."""

    our_keys, our_random, peer, peer_bundle = await setup()

    first_plaintext = b"Hallo aus python-oldmemo."
    content, plain_key_material = await peer.encrypt_plaintext(first_plaintext)
    session, encrypted = await peer.build_session_active(
        OUR_JID, OUR_DEVICE_ID, our_keys.bundle(), plain_key_material
    )
    key_exchange, _ = session.key_exchange.serialize(encrypted.serialize())

    messages: List[Dict[str, Any]] = []
    for index in range(1, PEER_FOLLOW_UPS + 1):
        plaintext = f"Nachricht {index} von Alice.".encode("utf-8")
        content_n, plain_n = await peer.encrypt_plaintext(plaintext)
        encrypted_n = await peer.encrypt_key_material(session, plain_n)
        # The first follow-up is recorded in both shapes. Until Alice decrypts something from us
        # her session stays unconfirmed, so a real client keeps wrapping every message in the
        # same key exchange — which our side has to accept on an established session.
        wrapped = session.key_exchange.serialize(encrypted_n.serialize())[0] if index == 1 else None
        messages.append(message_json(plaintext, content_n, plain_n, encrypted_n.serialize(), wrapped))

    # Burn through the chain and keep only the far message, so the fixture carries one real
    # message that is further ahead than any sane skipped-key limit.
    skip_ahead: Dict[str, Any] = {}
    for index in range(PEER_FOLLOW_UPS + 1, PEER_SKIP_AHEAD_INDEX + 1):
        plaintext = f"Nachricht {index} von Alice.".encode("utf-8")
        content_n, plain_n = await peer.encrypt_plaintext(plaintext)
        encrypted_n = await peer.encrypt_key_material(session, plain_n)
        if index == PEER_SKIP_AHEAD_INDEX:
            skip_ahead = message_json(plaintext, content_n, plain_n, encrypted_n.serialize())
            skip_ahead["index"] = index

    return {
        "$comment": (
            "Recorded from python-oldmemo by app/tests/fixtures/omemo/generate.py. "
            "Synthetic keys and JIDs; do not edit by hand."
        ),
        "namespace": "eu.siacs.conversations.axolotl",
        "us": our_keys.json(),
        "ourRandom": b64(our_random),
        "peer": {"jid": PEER_JID, "deviceId": PEER_DEVICE_ID, "bundle": bundle_json(peer_bundle)},
        "peerToUs": {
            "keyExchange": {
                **message_json(first_plaintext, content, plain_key_material, encrypted.serialize()),
                "keyExchange": b64(key_exchange),
            },
            "messages": messages,
            "skipAhead": skip_ahead,
        },
    }


async def replay(ours: Dict[str, Any]) -> Dict[str, Any]:
    """Hand what `emit.ts` produced to python-oldmemo and record what it makes of it."""

    _, _, peer, _ = await setup()

    key_exchange, authenticated_message = KeyExchangeImpl.parse(unb64(ours["keyExchange"]), False)
    session, plain_key_material = await peer.build_session_passive(
        OUR_JID,
        OUR_DEVICE_ID,
        key_exchange,
        EncryptedKeyMaterialImpl.parse(authenticated_message, OUR_JID, OUR_DEVICE_ID),
    )
    decrypted: List[str] = [
        (
            await peer.decrypt_plaintext(
                _content(ours["payloads"][0]),
                plain_key_material,
            )
        ).decode("utf-8")
    ]

    for index, message in enumerate(ours["messages"], start=1):
        plain = await peer.decrypt_key_material(
            session,
            EncryptedKeyMaterialImpl.parse(unb64(message), OUR_JID, OUR_DEVICE_ID),
        )
        decrypted.append(
            (await peer.decrypt_plaintext(_content(ours["payloads"][index]), plain)).decode("utf-8")
        )

    # Alice answers. Her first reply carries a new ratchet key, so decrypting it is what makes
    # our side take a Diffie-Hellman step rather than just walking a chain.
    replies: List[Dict[str, Any]] = []
    for index in range(1, 3):
        plaintext = f"Antwort {index} von Alice.".encode("utf-8")
        content_n, plain_n = await peer.encrypt_plaintext(plaintext)
        encrypted_n = await peer.encrypt_key_material(session, plain_n)
        replies.append(message_json(plaintext, content_n, plain_n, encrypted_n.serialize()))

    signature_valid = xeddsa.ed25519_verify(
        unb64(ours["signature"]["signature"]),
        xeddsa.curve25519_pub_to_ed25519_pub(unb64(ours["signature"]["identityKey"]), False),
        StateImpl.serialize_public_key(unb64(ours["signature"]["signedPreKey"])),
    )

    return {
        "$comment": (
            "python-oldmemo's reading of what @curlew/omemo produced, recorded by "
            "app/tests/fixtures/omemo/generate.py. Do not edit by hand."
        ),
        "namespace": "eu.siacs.conversations.axolotl",
        "usToPeer": {
            "keyExchange": ours["keyExchange"],
            "messages": ours["messages"],
            "payloads": ours["payloads"],
            "decrypted": decrypted,
        },
        "signatureAccepted": signature_valid,
        "peerReplies": replies,
    }


def _content(payload: Dict[str, str]) -> ContentImpl:
    """A payload our side emitted, in the form :meth:`Oldmemo.decrypt_plaintext` accepts.

    It has to be the real class, not a duck type — ``decrypt_plaintext`` asserts on the concrete
    type before it reads a single field.
    """

    return ContentImpl(unb64(payload["ciphertext"]), unb64(payload["iv"]))


def run_emitter(record_path: Path, out_path: Path) -> None:
    """Build and run ``emit.ts`` on node, so our side of the fixtures is our own code."""

    bundle = ROOT / "app" / "dist" / "omemo-emit.node.mjs"
    gjsify = ROOT / "node_modules" / ".bin" / "gjsify"
    subprocess.run(
        [str(gjsify), "build", "tests/fixtures/omemo/emit.ts", "--app", "node", "--outfile", str(bundle)],
        cwd=ROOT / "app",
        check=True,
    )
    subprocess.run(["node", str(bundle), str(record_path), str(out_path)], cwd=ROOT, check=True)


def write(path: Path, document: Dict[str, Any]) -> None:
    path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(ROOT)}")


def main() -> int:
    require_fixed_hash_seed()
    seed_ratchet_key_generation()

    phase = sys.argv[1] if len(sys.argv) > 1 else "all"
    if phase not in {"all", "record", "emit", "replay"}:
        print(f"usage: {sys.argv[0]} [all|record|emit|replay]", file=sys.stderr)
        return 2

    peer_to_us = HERE / "legacy-peer-to-us.json"
    us_to_peer = HERE / "legacy-us-to-peer.json"

    if phase in {"all", "record"}:
        seed_prng()
        write(peer_to_us, asyncio.run(record()))

    emitted = Path(os.environ.get("OMEMO_EMITTED", "")) if os.environ.get("OMEMO_EMITTED") else None
    with tempfile.TemporaryDirectory() as scratch:
        if emitted is None:
            emitted = Path(scratch) / "emitted.json"
        if phase in {"all", "emit"}:
            run_emitter(peer_to_us, emitted)
        if phase in {"all", "replay"}:
            ours = json.loads(emitted.read_text(encoding="utf-8"))
            seed_prng()
            write(us_to_peer, asyncio.run(replay(ours)))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
