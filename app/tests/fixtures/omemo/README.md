# OMEMO protocol fixtures

Recorded from [python-oldmemo](https://github.com/Syndace/python-oldmemo), the reference
implementation of `eu.siacs.conversations.axolotl`. The tests of `@curlew/omemo` read them from
disk; nothing here is bundled into the app.

## Why they exist

A wire format we serialize and then parse back is self-consistent no matter how wrong it is. The
only check worth anything is against an implementation that already talks to Conversations,
Gajim and Dino — so every byte sequence in these files was either **produced** by python-oldmemo
or **accepted** by it, and `generate.py` is the record of how.

## The files

| File | What is in it |
|---|---|
| `generate.py` | The recorder. Three phases: `record`, `emit`, `replay`; `all` is the default. |
| `emit.ts` | Driven by the `emit` phase — our code as the initiator, writing what it emits. |
| `legacy-peer-to-us.json` | python-oldmemo as Alice: her bundle, a key exchange, four follow-ups, one message far ahead in the chain, plus our private keys and the random stream our side draws from. |
| `legacy-us-to-peer.json` | What python-oldmemo made of our output: the plaintexts it recovered, whether it accepted our XEdDSA signature, and two replies that force our ratchet through a Diffie-Hellman step. |

## Regenerating

```sh
python3 -m venv .venv-omemo-fixtures
.venv-omemo-fixtures/bin/pip install oldmemo
.venv-omemo-fixtures/bin/python app/tests/fixtures/omemo/generate.py
```

Recorded with oldmemo 2.1.0, python-omemo 2.1.0, DoubleRatchet 1.3.0, X3DH 1.3.0, XEdDSA 1.2.0.

A rerun must leave both JSON files **byte-identical**; if it does not, something in the chain
became non-deterministic again and the diff is worthless as a review artefact. Three separate
measures keep it that way, and all three are load-bearing — see the functions they live in:

- `seed_prng` replaces `secrets.token_bytes`/`secrets.choice`, and runs again per phase.
- `seed_ratchet_key_generation` catches the ratchet keys, which python draws straight from the
  system CSPRNG.
- `require_fixed_hash_seed` pins `PYTHONHASHSEED`, because python-omemo assigns pre key ids by
  walking a `frozenset` of raw key bytes.

## Keys and JIDs

All synthetic, all derived from the fixed seed `curlew omemo fixtures v1`: `alice@example.org`
(device 42) and `bob@example.org` (device 1337). No key, address or identity here belongs to a
real account, and none is used anywhere outside these tests.
