# Telegram Chat Backend — Gaps vs XMPP/Matrix

Numbered by severity (real bug → documented limitation → cosmetic). File:line references from `packages/telegram/`.

## Real Bugs (incorrect behavior, data loss, or contract violation)

1. **session.ts:12–27** `page()` returns `exhausted: true` on the initial window (`afterSeq === null`) — tells the engine "chat caught up" when only a window was fetched. A short window (`raw.length < limit`) also sets `reachedStart: true` even if older messages exist (channel caps, not start of chat). **Effect**: full-scan never re-fetches older history; incremental runs think they're done.

2. **session.ts:44–60** `fetchHistory` never returns `retracted` in `ChatHistoryPage` and `revisions()` is not implemented. Per AGENTS.md, Telegram reports deletions only as live updates; without a daemon, `sync --full-scan` **cannot detect server-side deletions**. XMPP/Matrix return `retracted` on every page.

3. **session.ts:18–19** `page()` computes `highestSeq`/`lowestSeq` from filtered messages (service notices excluded), but contract expects them to cover *all* entries including service notices (for deletion proof range). A page with only service notices returns `highestSeq: null`, breaking `deletedBy()` logic.

4. **session.ts:54–58** Forward walk uses `offset: { id: afterSeq + 1, date: 0 }` with `reverse: true`. MTProto `getHistory` with `reverse` starts *at* `offset.id` inclusively, so `afterSeq + 1` is correct. **But** message IDs are monotonic only within a chat; for channels/supergroups the ID space is per-chat, which is fine. No bug here, but the assumption is undocumented.

5. **map.ts:74–76** `remoteMessageId` embeds chatId: `${chatId}/${messageId}`. XMPP uses global archiveId, Matrix uses global `$eventId:domain`. Embedding is valid per contract (opaque, unique within account) but **breaks consumers that parse the ID** (e.g. expecting a simple integer). No collision risk.

## Deliberate Documented Limitations (known, not fixable without network support)

6. **manifest.ts:18–19** `reactions: false` — comment "map.ts drops them in toChatMessage" is **correct**: `toChatMessage` has no reaction handling. Consistent with XMPP/Matrix (both `reactions: false`).

7. **manifest.ts:22** `threads: true` — only forum topic threads (`isTopicMessage`) supported; reply chains everywhere not mapped to `threadRemoteId`. XMPP `threads: false`, Matrix `threads: true` (both reply + thread).

8. **manifest.ts:27** `e2ee: false` — secret chats out of scope. Documented in terms. XMPP `false` (OMEMO not implemented), Matrix `true`.

9. **manifest.ts:30–31** `attachments: false` — "hasAttachments metadata only; no download path in session.ts". **Correct**: `hasAttachments` is populated (map.ts:92), but no download method exists in `ChatSession` port. Consistent with XMPP/Matrix.

10. **manifest.ts:17** `edits: true` — Telegram provides `editedAt` on each message (map.ts:88) but **does not emit `ChatHistoryPage.edits`** for corrections outside the page. XMPP/Matrix emit edits via `edits` array. The capability is "network supports edits" — Telegram does, so `true` is defensible, but the implementation is incomplete vs contract.

## Cosmetic Inconsistencies (works but differs from siblings)

11. **map.ts:65** `ChatInfo.lastCursor` **never set** (not even `null`). XMPP sets it (MAM archiveId), Matrix doesn't. Contract: optional. Missing field may confuse generic code that checks `chat.lastCursor !== undefined`.

12. **map.ts:65–66** `readInboxSeq`/`readOutboxSeq` use dialog's `lastReadIngoing`/`lastReadOutgoing` — these are **per-dialog read markers**, not per-message. Matrix uses `readUpToTs`/`peerReadUpToTs` (per-message timestamps). Semantics differ: Telegram marks "everything ≤ N read", Matrix marks "everything ≤ timestamp read". Both populate the fields, but meaning differs.

13. **map.ts:91** `text` includes reply fallback (quoted text) — XMPP/Matrix **strip** reply fallback (`stripReplyFallback`). Telegram message text is raw; consumers see duplicated quoted text in threads.

14. **map.ts:92** `hasAttachments` checks `FILE_MEDIA` set — includes `'paid'` (Telegram Stars paid media). XMPP checks `attachmentUrls.length > 0`, Matrix checks file msgtype. Semantic difference: paid media may not be a "file a person sent".

15. **map.ts:94–95** `threadRemoteId` only for forum topics (`isTopicMessage && reply?.threadId`). Reply chains in regular chats not mapped. Matrix maps both `m.thread` and reply fallback. XMPP maps neither.

16. **session.ts:48–51** Window fetch (`afterSeq === null`) returns `exhausted: true, reachedStart: raw.length < limit`. Matrix window returns `exhausted: true, reachedStart: walk.reachedStart` (true only if room start actually reached). XMPP window returns `exhausted: true, reachedStart: page.complete`. Telegram's `reachedStart` is a **heuristic, not authoritative**.

17. **map.ts:88** `editedAt` populated directly on message — XMPP/Matrix set `editedAt: null` on message and emit corrections via `ChatHistoryPage.edits`. Telegram's approach is **more complete for in-page edits** but **misses cross-page corrections** (no `edits` array).

18. **session.ts:12–27** `page()` sorts messages oldest-first (`a.id - b.id`) — correct per contract. But it filters by `m.id > afterSeq` *before* sorting, which is correct. However, the filter uses `>` (strictly newer), matching contract "strictly newer than afterSeq".

19. **manifest.ts:23** `readReceipts: true` — XMPP `false` (markers unreliable), Matrix `true`. Telegram's is per-dialog, Matrix's per-message. Both claim `true` but granularity differs.

20. **api.ts:58–60** `TgDialog.lastReadIngoing`/`lastReadOutgoing` are `number` (not nullable) but can be 0. Map treats 0 as `null` (falsy). If a chat genuinely has read marker at message 0, it becomes `null`. Edge case.

21. **session.ts:62–64** `close()` only calls `api.destroy()` — no persistence of read markers or session state. XMPP/Matrix persist nothing either (stateless), but Matrix saves crypto ledger in `close()`. Telegram auth key persisted by mtcute separately.

22. **map.ts:79–96** `toChatMessage` returns `null` for `isService` — consistent with XMPP (filters in `buildPage`) and Matrix (filters in `toChatMessage`). But Telegram service messages include joins/pins which could be `notice: true` per contract. Currently dropped entirely.

23. **session.ts:44–60** `fetchHistory` ignores `afterCursor` parameter — Telegram doesn't page by cursor. XMPP uses it (MAM archiveId), Matrix ignores it (uses timestamp walk). Contract allows ignoring.

24. **manifest.ts:35** `syncModel: 'server-archive'` — correct. But Telegram's "archive" is limited to cloud chats; secret chats are not archived. Documented in terms.

25. **map.ts:26–36** `peerAddresses` for groups/channels only includes username — no numeric ID for groups (MTProto uses negative IDs). XMPP uses bare JID, Matrix uses roomId. Telegram group `remoteId` is negative number string — works but differs from peers.

26. **session.ts:36–42** `listChats` iterates dialogs via `iterDialogs()` — returns all dialogs including archived/hidden. XMPP filters to roster+bookmarks, Matrix to joined rooms. Telegram includes more chats than user may expect.

27. **session.ts:46** Validates `chatRemoteId` as safe integer — throws if not. XMPP/Matrix accept string IDs. Telegram IDs are numeric; validation is correct but stricter.

28. **map.ts:83–84** `sender` is `null` for outgoing OR when sender is anonymous — contract: "Null when sender is the user OR not disclosed". Anonymous senders in channels: sender is `{ type: 'anonymous' }`, correctly mapped to `null`.

29. **map.ts:89** `fromSelf: message.isOutgoing` — correct. XMPP/Matrix compute from JID/userId comparison. All consistent.

30. **Overall** No `revisions()` implementation — optional per interface, but Matrix uses it for decryption retries. Telegram has no equivalent need (no E2EE in cloud chats). Not a gap.