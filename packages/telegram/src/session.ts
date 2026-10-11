/**
 * One connected Telegram account as a `ChatSession` — the chat driver the sync engine calls.
 *
 * Works on `TelegramApi` only, so a fake client with recorded (synthetic) dialogs and messages
 * drives it in the unit tests exactly as mtcute does in production.
 */

import { ChatRateLimitedError } from '@curlew/protocol';
import type { ChatHistoryPage, ChatInfo, ChatSession } from '@curlew/protocol';
import type { TelegramApi, TgMessage } from './api.ts';
import { toChatInfo, toChatMessage } from './map.ts';

// Telegram returns at most 100 messages per `getHistory`, whatever the `limit` asked for
// (core.telegram.org/api/offsets). The sync engine's window is 200, so one call never fills it.
const SERVER_HISTORY_CAP = 100;

/**
 * mtcute's FLOOD_WAIT as the port's own error, or null when this is not one.
 *
 * mtcute sleeps a wait below `floodSleepThreshold` (10 s by default) itself and THROWS above it:
 * an `RpcError` whose `text` is the normalized `'FLOOD_WAIT_%d'` and whose `seconds` is the wait.
 * Read structurally, not with `instanceof`: `RpcError` is not exported from @mtcute/core's root,
 * and a fake client in a test throws a plain object. A raw, unnormalized `FLOOD_WAIT_<n>` is
 * matched too. Anything else is not a rate limit and passes through untouched.
 */
export function asChatRateLimited(err: unknown): ChatRateLimitedError | null {
  if (!err || typeof err !== 'object') return null;
  const text = (err as { text?: unknown }).text;
  const seconds = (err as { seconds?: unknown }).seconds;
  if (typeof text === 'string' && /^FLOOD_WAIT_(?:\d+|%d)$/.test(text) && typeof seconds === 'number') {
    return new ChatRateLimitedError(Math.max(0, Math.round(seconds * 1000)));
  }
  return null;
}

function page(
  raw: ReadonlyArray<TgMessage>,
  afterSeq: number | null,
  exhausted: boolean,
  reachedStart: boolean,
): ChatHistoryPage {
  const fresh = afterSeq === null ? raw : raw.filter((m) => m.id > afterSeq);
  const ordered = [...fresh].sort((a, b) => a.id - b.id);
  return {
    messages: ordered.map(toChatMessage).filter((m) => m !== null),
    highestSeq: ordered.length > 0 ? ordered[ordered.length - 1].id : null,
    lowestSeq: ordered.length > 0 ? ordered[0].id : null,
    exhausted,
    reachedStart,
  };
}

export class TelegramChatSession implements ChatSession {
  private readonly api: TelegramApi;

  constructor(api: TelegramApi) {
    this.api = api;
  }

  /**
   * Run one network call and translate a FLOOD_WAIT at the session boundary. EVERY call that can
   * be throttled goes through here, so the sync engine sees one error type whatever mtcute threw.
   */
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      throw asChatRateLimited(err) ?? err;
    }
  }

  async listChats(): Promise<ChatInfo[]> {
    const chats: ChatInfo[] = [];
    // Resolving a chat later needs its access hash, which mtcute stores from this very listing —
    // so the sync engine always lists before it fetches.
    //
    // `archived: 'keep'` is load-bearing: mtcute defaults to `'exclude'`, which asks Telegram for
    // the main folder alone. Without it an archived chat is not de-prioritised, it is INVISIBLE —
    // archiving a group in Telegram would silently drop it from curlew's index and the
    // conversation list, with nothing to say so.
    try {
      for await (const dialog of this.api.iterDialogs({ archived: 'keep' })) chats.push(toChatInfo(dialog));
    } catch (err) {
      throw asChatRateLimited(err) ?? err;
    }
    return chats;
  }

  async fetchHistory(chatRemoteId: string, afterSeq: number | null, limit: number): Promise<ChatHistoryPage> {
    const chatId = Number(chatRemoteId);
    if (!Number.isSafeInteger(chatId)) throw new Error(`not a Telegram chat id: ${chatRemoteId}`);
    if (afterSeq === null) {
      // The newest `limit` messages, so the chat is caught up once they are in. Telegram caps one
      // call at SERVER_HISTORY_CAP, which the engine's window exceeds, so page backwards: newest
      // first with an `offset` id returns messages strictly BELOW it, and the lowest id collected
      // is the next page's offset. A short chunk is NOT proof that nothing older exists — only an
      // EMPTY one is — and it must not be treated as one: `reachedStart` makes the full scan treat
      // everything below the window as deleted on the server, which drops messages that exist. A
      // false positive destroys index data; a false negative costs one request.
      const collected: TgMessage[] = [];
      let lowestId: number | null = null;
      let reachedStart = false;
      while (collected.length < limit) {
        const params: { limit: number; offset?: { id: number; date: number } } = {
          limit: Math.min(SERVER_HISTORY_CAP, limit - collected.length),
        };
        if (lowestId !== null) params.offset = { id: lowestId, date: 0 };
        const chunk = await this.call(() => this.api.getHistory(chatId, params));
        if (chunk.length === 0) {
          reachedStart = true;
          break;
        }
        collected.push(...chunk);
        lowestId = Math.min(lowestId ?? Infinity, ...chunk.map((m) => m.id));
      }
      return page(collected, null, true, reachedStart);
    }
    // Oldest first, starting AT the offset id — hence the +1, so `afterSeq` itself is excluded.
    // Asking for more than the cap would make a capped answer look like "nothing left", so `ask`
    // bounds the request and the comparison that decides `exhausted`.
    const ask = Math.min(limit, SERVER_HISTORY_CAP);
    const raw = await this.call(() =>
      this.api.getHistory(chatId, {
        limit: ask,
        offset: { id: afterSeq + 1, date: 0 },
        reverse: true,
      }),
    );
    return page(raw, afterSeq, raw.length < ask, false);
  }

  /**
   * Which of these stored messages Telegram no longer has (ADR 0004).
   *
   * `messages.getMessages` answers with one slot per asked id and an EMPTY message where there is
   * none — which for an id this account once saw is positive proof it was deleted; mtcute reports
   * that slot as `null`. The two official web clients resolve single messages the same way
   * (Telegram K `appMessagesManager.ts`, `needSingleMessages`; Telegram A `messages.ts`,
   * `fetchMessage` → `MessageEmpty` = deleted).
   *
   * Only ids of THIS chat are asked, in chunks of the server's 100: Telegram's message ids are
   * per-chat for channels and supergroups, so an id from another chat would resolve to a
   * different message — or to nothing, which would read as "deleted". A chunk that throws
   * (FLOOD_WAIT that outlasted mtcute's waiter, a chat that no longer resolves) ends the probe
   * right there and the ids it did not get an answer for are left out.
   */
  async probeRetracted(chatRemoteId: string, remoteIds: readonly string[]): Promise<string[]> {
    const chatId = Number(chatRemoteId);
    if (!Number.isSafeInteger(chatId)) throw new Error(`not a Telegram chat id: ${chatRemoteId}`);
    // `remoteMessageId` is `<chatId>/<messageId>`; an id from elsewhere is not ours to judge.
    const prefix = `${chatId}/`;
    const asked = remoteIds
      .filter((remoteId) => remoteId.startsWith(prefix))
      .map((remoteId) => ({ remoteId, id: Number(remoteId.slice(prefix.length)) }))
      .filter((m) => Number.isSafeInteger(m.id) && m.id > 0);
    const gone: string[] = [];
    for (let i = 0; i < asked.length; i += SERVER_HISTORY_CAP) {
      const chunk = asked.slice(i, i + SERVER_HISTORY_CAP);
      const found = await this.call(() =>
        this.api.getMessages(
          chatId,
          chunk.map((m) => m.id),
        ),
      );
      // A short answer says nothing about the ids past its end: those stay in the index.
      for (let j = 0; j < chunk.length && j < found.length; j++) {
        if (found[j] === null) gone.push(chunk[j].remoteId);
      }
    }
    return gone;
  }

  async close(): Promise<void> {
    await this.api.destroy();
  }
}
