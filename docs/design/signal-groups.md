# Signal group names

Status: proposal, needs a decision. Until it is built an untitled group reads *Unnamed group · N
members* (placeholder, built).

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

## Decision needed

`guard.ts` lists "profile or group fetches" as requests curlew never sends, and its allowlists
are fail-closed. This feature widens that list with one read-only phase: `groups`, naming the two
requests above, with a test per request. It adds one new outbound host (`storage.signal.org`) and
one new request kind on the chat connection, both read-only and both only for groups the person
already belongs to. The trade-off is a new endpoint reachable from the sync process against a
readable group name. Build only after the person agrees.

## Pieces

1. `groups` phase in the guard, with tests that refuse every other request.
2. Credential and storage client in `packages/signal`, behind a fake in tests (synthetic group
   with a locally derived key).
3. Title decrypt, cache and refresh rule; the mapper keeps a group's title when a message has none.
4. Live check against a real group from the self-account, counts and one title only.
