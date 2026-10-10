# ADR 0004 — deletions below the re-read window are probed by id, on a rotating sweep

- **Status:** Accepted (2026-10-10)
- **Scope:** `@curlew/protocol` (`ChatSession.probeRetracted`), `@curlew/store` (chat sync engine,
  index schema v8), `@curlew/telegram`; any later backend that can ask about a message by id
- **Closes:** [#38](https://github.com/JumpLink/curlew/issues/38)

## Context

The chat engine is a **server-archive** model (ADR 0001 §2): the network keeps the history, the
index holds a window of it. An incremental run only walks FORWARD from the stored cursor, so it
cannot see a message that was deleted behind it. A full scan (`sync --full-scan`) re-takes each
chat's newest window and `deletedBy` removes every stored message inside the range that window
covered but no longer contains.

That leaves a hole with a sharp edge: **the window has a bottom.** Its default is 200 messages,
and the index of a chat grows past it with every forward walk. A message deleted below the
window's lowest sequence is in no page any full scan re-reads, so `deletedBy` never gets to see
it and it stays in the index — searchable, MCP-readable — for good.

The networks that report deletions in their history (XMPP retractions, Matrix redactions) do not
have this hole: the retraction travels in the archive and `ChatHistoryPage.retracted` applies it
on every run, however deep the target. Telegram has no such feed for a run-and-exit client.
`updates.getDifference` / `channels.getDifference` carry deletions as live updates, but only from
the `pts` the client last held — a client with `disableUpdates: true` that exits after each sync
has no usable `pts`, and Telegram's difference has a horizon beyond which it answers
`differenceTooLong` and says only "resync from scratch". So the update stream cannot answer "is
this message from eight months ago still there".

What Telegram *does* answer cheaply is the direct question. `messages.getMessages` /
`channels.getMessages` take up to 100 ids per call and return `messageEmpty` — mtcute maps it to
`null` — at the position of an id the server no longer has. That is a **positive proof of
deletion**, which matters because the asymmetry here is not symmetric at all: a false "deleted"
destroys index data the user cannot get back, a false negative costs one request on the next run.

Three things had to be decided together, and none of them is settled by the issue.

1. **Where the ids come from.** The index knows what was stored; the backend knows how to ask the
   network. `store` must not import a backend, and `ChatSession.revisions()` takes no arguments,
   so a Telegram session cannot reach the stored ids on its own. Matrix's `revisions()` works
   because Matrix keeps **its own** ledger of what to retry; Telegram has nothing to keep.
2. **What it costs.** Probing every stored message of every chat on every full scan is
   `ceil(N/100)` calls per chat. For a heavy account after a year that is hundreds of calls, and
   FLOOD_WAIT is what Telegram answers with.
3. **Whether a bounded probe ever reaches the deep tail.** A bound that always probes the same
   slice — the newest below the window, say — verifies that slice forever and never looks at the
   bottom of the chat, which is exactly the region no other mechanism covers.

## Decision

**A new optional port method, driven by the engine, over a rotating sweep with a per-chat bound.**

```ts
probeRetracted?(chatRemoteId: string, remoteIds: readonly string[]): Promise<string[]>;
```

- **The engine asks, the backend answers.** The engine owns the index, so it picks the ids; the
  backend owns the network, so it decides how to ask (Telegram chunks by 100). The port stays
  network-neutral: nothing in the signature names Telegram, and a backend that cannot ask by id
  simply has no such method — an absent `probeRetracted` is a fact about the network, not an
  error, exactly like `revisions`.
- **Only what the server answered.** An implementation returns an id only for a slot the server
  positively reported empty. A failed, partial or shorter-than-asked answer says nothing about
  the ids it left out and must return none of them.
- **Full scan only.** The probe runs where `loadStoredSeqs` already runs — the one pass that can
  tell a deleted message from one that was never fetched. An incremental `sync` is unchanged and
  costs nothing new.
- **Bounded per chat per run:** `CHAT_PROBE_DEPTH` (200 ids, two MTProto calls), only for stored
  messages BELOW the window the run re-read. Above it `deletedBy` already decides, and a window
  that reached the chat's start leaves nothing to probe.
- **Rotating, so the bound still reaches the bottom.** `chat_cursors.probe_seq` (schema v8)
  remembers how far the last sweep got. Each full scan takes the next `CHAT_PROBE_DEPTH`
  candidates *above* it, oldest first, and advances it; a sweep that runs out of candidates
  resets it to NULL, so the next full scan starts again at the chat's oldest stored message.
  Over successive full scans the whole stored history is verified, at a cost per run that does
  not grow with the index.
- **A failing probe changes nothing.** `probe_seq` stays where it was, no message is removed, and
  the same slice is asked again on the next run. A FLOOD_WAIT costs a delay, never data.

### Why not the alternatives

| Option | Why not |
|---|---|
| `channels.getDifference` / `updates.getDifference` | needs a `pts` a run-and-exit client does not keep, and has a horizon (`differenceTooLong`) past which it refuses — it cannot answer about old messages at all |
| Re-fetch the full history every full scan | 100 messages per `getHistory`: a 50 000-message chat is 500 calls for information that `getMessages` gives in 500 ids per 5 calls, and it is the straight road into FLOOD_WAIT |
| Overload `revisions()` with the stored ids | `revisions()` means "what the backend learned on its own, outside a page"; passing the index into it merges two different questions into one hook and would make Matrix's own ledger-driven path read as if the engine drove it |
| Keep a Telegram-side ledger like Matrix's | the ledger would be a second copy of what `conversation_messages` already holds, and it would have to be kept in step with the index's own deletions |
| An unbounded probe | the cost grows with the index forever, for a scan the user already waits on |
| A bounded probe without a cursor | verifies one slice for ever and never sees the bottom of the chat, which is the only region that needed it |

### What the official web clients do

Checked against the two clients Telegram ships itself, because a mechanism they do not use is a
mechanism to distrust.

- Both learn about deletions from the update stream, via `pts` and
  `updates.getChannelDifference` — **Telegram K** `src/lib/appManagers/apiUpdatesManager.ts:435-456`,
  **Telegram A** `src/api/gramjs/updates/updateManager.ts:397-421`. That is not available to
  curlew: both are long-lived socket clients that hold a session open and keep `pts` across
  restarts, while curlew connects, syncs and exits (`disableUpdates: true`). Confirms the
  rejection above rather than contradicting it.
- Both fall back to reloading **by id** when the difference is useless — exactly curlew's
  situation, only permanent instead of occasional: on `channelDifferenceTooLong` Telegram A calls
  `forceSync()` (`updateManager.ts:502-503`) and reloads, Telegram K re-fetches the affected
  peer's messages.
- Both resolve a single message with `messages.getMessages` / `channels.getMessages` and read a
  missing one as deleted: **Telegram K** `src/lib/appManagers/appMessagesManager.ts:14086-14130`
  (the `needSingleMessages` batch), **Telegram A** `src/api/gramjs/methods/messages.ts:285-310`
  (`fetchMessage`, `mtpMessage instanceof GramJs.MessageEmpty` → `MESSAGE_DELETED`).

Adopted from them: batch the ids into one call (chunk of 100, as Telegram K's
`needSingleMessages` does) and treat an *empty* message like a missing one — mtcute already maps
`messageEmpty` to `null`, so one check covers both.

## Consequences

- **`capabilities` gains nothing.** Being able to ask by id is a property of the *mechanism*, not a
  feature of the network a frontend could show, and the manifest's capabilities are read by
  frontends. The presence of the method is the statement.
- **A deeper deletion now takes up to `ceil(stored / 200)` full scans** to be noticed, where
  before it was never noticed at all. The README says so rather than promising immediacy.
- **`chat_cursors` has a new column that a cursor write must carry.** The row is written with
  `INSERT OR REPLACE`, so every run has to pass `probe_seq` through or a replace would silently
  reset the sweep to the bottom on every sync. The same trap as the `conversations` aggregates.
- **Pinned by tests.** The deep deletion is asserted end to end through `TelegramBackend` with the
  fake client — the way #32 pinned `edits` — and the engine test asserts both the bound and that
  the sweep rotates, so narrowing either stays a visible decision instead of a quiet regression.
- **The next backend that can ask by id gets it for free**: implement `probeRetracted` and the
  engine's sweep applies. Nothing in `@curlew/store` needs to change for it.
