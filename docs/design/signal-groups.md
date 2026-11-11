# Signal group names

Status: accepted and built (#211). Until a group's name is known it reads *Unnamed group · N
members* (placeholder).

## Problem

A Signal message in a group carries only the group's master key. The name, avatar and member list
live on the Groups v2 service, encrypted with a key derived from that master key. Curlew never
asks for them, so every Signal group row has `title IS NULL`. Signal members have no profile
names either (the profile fetch is not done), so the list can show nothing better than the member
count.

## What a fetch needs

1. A group auth credential: `GET /v1/certificate/auth/group?redemptionStartSeconds=…&redemptionEndSeconds=…`
   on the authenticated chat connection. The response carries `AuthCredentialWithPniResponse`
   values (libsignal-client zkgroup).
2. A presentation of that credential for the group's public params, derived from the master key
   (`GroupSecretParams.deriveFromMasterKey`, already used in `backend.ts` for the group id).
3. `GET /v2/groups` on `storage.signal.org` with the presentation as Basic credentials. That is
   an HTTPS request to another host, not a chat WebSocket request, pinned to Signal's private
   root (`SIGNAL_ROOT_CA_PEM`).
4. The response is a protobuf `Group`; `title` is an encrypted blob, decrypted with
   `GroupSecretParams` (`decryptBlobWithPadding`) into a `GroupAttributeBlob`.

The title is cached per group in the index (`conversations.title`) and refreshed only when the
group's revision in a message is higher than the cached one.

## Decision

The person left the approach to the implementer on 2026-11-11 and expected it to be fine. `guard.ts` gained one read-only phase, `groups`, naming
exactly the two requests above (`groupsRefusal`, `storageRefusal`), with a test per refused
request. It adds one outbound host (`storage.signal.org`) and one request kind on the chat
connection, both only for groups the account already belongs to. A fetch opens its own chat
connection, so the receive session still has no `fetch` at all.

Where it differs from the first proposal: the title is cached in the session file
(`signal.groups`: revision, name, last attempt; never the master key), not in the index. The
name reaches the index as a normal `chat` event. A group is asked again only when a message
carries a newer revision, or after six hours when the last answer was empty or failed. A failed
fetch never fails the sync; it is reported once per run. A group is named only when a message
arrives in it, so a quiet group stays unnamed until it speaks.

Off switch: `backends.signal.settings.groupNames: false`.

## Pieces

1. `groups` phase in the guard, with tests that refuse every other request.
2. Credential and storage client in `packages/signal`, behind a fake in tests (synthetic group
   with a locally derived key).
3. Title decrypt, cache and refresh rule; the mapper keeps a group's title when a message has none.
4. Live check against a real group from the self-account, counts and one title only (open until run).
