/**
 * One connected Telegram account as a `ChatSession` — the chat driver the sync engine calls.
 *
 * Works on `TelegramApi` only, so a fake client with recorded (synthetic) dialogs and messages
 * drives it in the unit tests exactly as mtcute does in production.
 */

import type { ChatHistoryPage, ChatInfo, ChatSession } from '@curlew/protocol';
import type { TelegramApi, TgMessage } from './api.ts';
import { toChatInfo, toChatMessage } from './map.ts';

// Telegram returns at most 100 messages per `getHistory`, whatever the `limit` asked for
// (core.telegram.org/api/offsets). The sync engine's window is 200, so one call never fills it.
const SERVER_HISTORY_CAP = 100;

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

  async listChats(): Promise<ChatInfo[]> {
    const chats: ChatInfo[] = [];
    // Resolving a chat later needs its access hash, which mtcute stores from this very listing —
    // so the sync engine always lists before it fetches.
    //
    // `archived: 'keep'` is load-bearing: mtcute defaults to `'exclude'`, which asks Telegram for
    // the main folder alone. Without it an archived chat is not de-prioritised, it is INVISIBLE —
    // archiving a group in Telegram would silently drop it from postbote's index and the
    // conversation list, with nothing to say so.
    for await (const dialog of this.api.iterDialogs({ archived: 'keep' })) chats.push(toChatInfo(dialog));
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
        const chunk = await this.api.getHistory(chatId, params);
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
    const raw = await this.api.getHistory(chatId, {
      limit: ask,
      offset: { id: afterSeq + 1, date: 0 },
      reverse: true,
    });
    return page(raw, afterSeq, raw.length < ask, false);
  }

  async close(): Promise<void> {
    await this.api.destroy();
  }
}
