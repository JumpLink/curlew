import type {
  ClientOptions,
  LoginPrompts,
  TelegramClientHandle,
  TelegramLive,
  TgChat,
  TgDialog,
  TgDialogsParams,
  TgMediaDownload,
  TgMessage,
  TgOutgoingFile,
  TgPeer,
  TgUser,
} from '@curlew/telegram';

/**
 * A fake mtcute client: recorded, SYNTHETIC dialogs and messages in the exact shapes mtcute's
 * classes have (`api.ts`), a scripted login, and the storage it was handed — so a test can check
 * what the backend asked mtcute to persist.
 *
 * `getHistory` implements mtcute's semantics, not a simplification of them: newest first by
 * default, and with `reverse` oldest first starting AT `offset.id`, inclusive.
 */

export function user(id: number, displayName: string, extra: Partial<TgUser> = {}): TgUser {
  return {
    type: 'user',
    id,
    username: null,
    phoneNumber: null,
    displayName,
    isBot: false,
    isSelf: false,
    ...extra,
  };
}

export function group(
  id: number,
  displayName: string,
  chatType = 'supergroup',
  username: string | null = null,
): TgChat {
  return { type: 'chat', id, chatType, displayName, username };
}

export function tgMessage(
  chat: TgPeer,
  id: number,
  sender: TgPeer | 'me',
  text: string,
  extra: Partial<TgMessage> = {},
): TgMessage {
  return {
    id,
    date: new Date(Date.UTC(2026, 7, 1, 9, 0, id)),
    editDate: null,
    sender: sender === 'me' ? ME : sender,
    chat,
    isOutgoing: sender === 'me',
    isService: false,
    text,
    media: null,
    replyToMessage: null,
    isTopicMessage: false,
    ...extra,
  };
}

export const ME = user(42, 'Me Example', {
  username: 'me_example',
  isSelf: true,
  phoneNumber: '49170000000',
});

export interface FakeScript {
  dialogs?: TgDialog[];
  history?: Map<number, TgMessage[]>;
  /** What `login` resolves with, after asking every prompt in order. */
  loginAs?: TgUser;
  /** Thrown by `connect`/`getMe` to simulate a revoked session. */
  unauthorized?: boolean;
  /**
   * Throw mtcute's `FLOOD_WAIT` from the named call — the exact object shape mtcute's `RpcError`
   * has after `RpcError.fromTl`: `text` normalized to `'FLOOD_WAIT_%d'`, `seconds` the wait.
   */
  floodWait?: { seconds: number; on: 'history' | 'dialogs' | 'messages' };
  /**
   * Reject the login AFTER Telegram accepted the sign-in and mtcute recorded the user — what
   * happens when the bookkeeping after `notifyLoggedIn` (the update manager, `start`'s own
   * follow-up calls) throws. The session is authorized at that point and must not be thrown away.
   */
  failAfterSignIn?: string;
  /** The bytes `openMedia` streams per message, keyed `<chatId>/<messageId>`, as the chunks given. */
  mediaBytes?: Map<string, Uint8Array[]>;
}

/**
 * mtcute's `RpcError` for a FLOOD_WAIT, as `RpcError.fromTl` normalizes it — the shape the
 * session boundary has to recognise. Not a real `RpcError` instance: that class is not exported
 * from @mtcute/core's root, and nothing in curlew should reach into its internals.
 */
export function floodWaitError(seconds: number): Error & { text: string; seconds: number } {
  return Object.assign(new Error(`Telegram API error 420: FLOOD_WAIT_${seconds}`), {
    code: 420,
    text: 'FLOOD_WAIT_%d',
    seconds,
  });
}

/**
 * Telegram's own cap on one `messages.getHistory`: it returns at most this many, whatever the
 * `limit` asked for (core.telegram.org/api/offsets; mtcute's `iterHistory` chunks by it).
 */
export const SERVER_HISTORY_CAP = 100;

export class FakeClient implements TelegramClientHandle {
  readonly storage: ClientOptions['storage'];
  readonly credentials: ClientOptions['credentials'];
  readonly script: FakeScript;
  readonly calls: string[] = [];
  /** Every `iterDialogs` argument the session passed, in order. */
  readonly dialogsParams: Array<TgDialogsParams | undefined> = [];
  destroyed = 0;
  /** Every `sendText` call, in order. */
  readonly sent: Array<{ chatId: number; text: string; replyTo?: number }> = [];
  private nextSentId = 9000;
  /** Present when the client was made with `live: true`; the test drives it with `arrive` and `end`. */
  readonly live?: TelegramLive;
  /** `live.start()` calls. */
  liveStarts = 0;
  private readonly arrivals = new Set<() => void>();
  private readonly closers: Array<(end: { reason: string; loggedOut: boolean }) => void> = [];

  constructor(options: ClientOptions, script: FakeScript) {
    if (options.live) {
      this.live = {
        start: async () => {
          this.liveStarts++;
        },
        onArrival: (listener) => {
          this.arrivals.add(listener);
          return () => this.arrivals.delete(listener);
        },
        onClosed: (listener) => {
          this.closers.push(listener);
        },
      };
    }
    this.storage = options.storage;
    this.credentials = options.credentials;
    this.script = script;
  }

  /** An update arrived: Telegram said something changed. */
  arrive(): void {
    for (const listener of this.arrivals) listener();
  }

  /** The connection gave up. */
  end(reason: string, loggedOut = false): void {
    for (const closer of this.closers) closer({ reason, loggedOut });
  }

  async connect(): Promise<void> {
    this.calls.push('connect');
    await this.storage.driver.load?.();
  }

  async getMe(): Promise<TgUser> {
    this.calls.push('getMe');
    if (this.script.unauthorized) {
      throw Object.assign(new Error('AUTH_KEY_UNREGISTERED'), { text: 'AUTH_KEY_UNREGISTERED' });
    }
    return ME;
  }

  async *iterDialogs(params?: TgDialogsParams): AsyncIterable<TgDialog> {
    // The archived handling is recorded, because it is a REAL behaviour of mtcute: the default
    // ('exclude') never returns an archived chat, and a test that does not look here cannot tell
    // a session that asked for both folders from one that forgot to ask.
    this.calls.push(`iterDialogs:${params?.archived ?? 'default'}`);
    this.dialogsParams.push(params);
    if (this.script.floodWait?.on === 'dialogs') throw floodWaitError(this.script.floodWait.seconds);
    for (const dialog of this.script.dialogs ?? []) yield dialog;
  }

  async getHistory(
    chatId: number,
    params: { limit: number; offset?: { id: number; date: number }; reverse?: boolean },
  ): Promise<ReadonlyArray<TgMessage>> {
    this.calls.push(
      `getHistory:${chatId}:${params.reverse ? `rev@${params.offset?.id}` : 'newest'}:${params.limit}`,
    );
    if (this.script.floodWait?.on === 'history') throw floodWaitError(this.script.floodWait.seconds);
    const all = [...(this.script.history?.get(chatId) ?? [])].sort((a, b) => a.id - b.id);
    const limit = Math.min(params.limit, SERVER_HISTORY_CAP);
    if (params.reverse) {
      const from = params.offset?.id ?? 1;
      return all.filter((m) => m.id >= from).slice(0, limit);
    }
    // Newest first, strictly below `offset.id` when one is given (how mtcute pages backwards).
    const below = params.offset?.id;
    return all
      .filter((m) => below === undefined || m.id < below)
      .reverse()
      .slice(0, limit);
  }

  async getMessages(chatId: number, messageIds: readonly number[]): Promise<ReadonlyArray<TgMessage | null>> {
    this.calls.push(`getMessages:${chatId}:${messageIds.join(',')}`);
    if (this.script.floodWait?.on === 'messages') throw floodWaitError(this.script.floodWait.seconds);
    // mtcute's contract: one slot per asked id, IN ORDER, `null` where Telegram has no message.
    const all = this.script.history?.get(chatId) ?? [];
    const byId = new Map(all.map((m) => [m.id, m]));
    return messageIds.slice(0, SERVER_HISTORY_CAP).map((id) => byId.get(id) ?? null);
  }

  async openMedia(chatId: number, messageId: number): Promise<TgMediaDownload | null> {
    this.calls.push(`openMedia:${chatId}/${messageId}`);
    const message = (this.script.history?.get(chatId) ?? []).find((m) => m.id === messageId);
    const chunks = this.script.mediaBytes?.get(`${chatId}/${messageId}`);
    if (!message?.media || !chunks) return null;
    return {
      media: message.media,
      chunks: (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
    };
  }

  async sendText(chatId: number, text: string, replyTo?: number): Promise<TgMessage> {
    this.calls.push(`sendText:${chatId}`);
    this.sent.push({ chatId, text, ...(replyTo === undefined ? {} : { replyTo }) });
    const chat = (this.script.dialogs ?? []).find((d) => d.peer.id === chatId)?.peer ?? user(chatId, 'Peer');
    return tgMessage(chat, this.nextSentId++, 'me', text);
  }

  /** Every `editMessage` and `deleteMessage` call, in order. */
  readonly edited: Array<{ chatId: number; messageId: number; text: string }> = [];
  readonly deleted: Array<{ chatId: number; messageId: number }> = [];

  async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    this.calls.push(`editMessage:${chatId}`);
    this.edited.push({ chatId, messageId, text });
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    this.calls.push(`deleteMessage:${chatId}`);
    this.deleted.push({ chatId, messageId });
  }

  /** Every `sendReaction` call, in order. */
  readonly reactions: Array<{ chatId: number; messageId: number; emoji: string | null }> = [];

  /** Set to make the next `sendReaction` fail the way an RPC error does: with a `text`. */
  reactionError: string | null = null;

  async sendReaction(chatId: number, messageId: number, emoji: string | null): Promise<void> {
    this.calls.push(`sendReaction:${chatId}`);
    if (this.reactionError !== null) throw Object.assign(new Error('rpc'), { text: this.reactionError });
    this.reactions.push({ chatId, messageId, emoji });
  }

  /** Every `sendFile` call, in order: the name, size and caption — the bytes are not kept. */
  readonly files: Array<{
    chatId: number;
    fileName: string;
    size: number;
    caption?: string;
    asPhoto: boolean;
    replyTo?: number;
  }> = [];

  async sendFile(chatId: number, file: TgOutgoingFile): Promise<TgMessage> {
    this.calls.push(`sendFile:${chatId}`);
    this.files.push({
      chatId,
      fileName: file.fileName,
      size: file.bytes.byteLength,
      asPhoto: file.asPhoto,
      ...(file.caption === undefined ? {} : { caption: file.caption }),
      ...(file.replyTo === undefined ? {} : { replyTo: file.replyTo }),
    });
    const chat = (this.script.dialogs ?? []).find((d) => d.peer.id === chatId)?.peer ?? user(chatId, 'Peer');
    return tgMessage(chat, this.nextSentId++, 'me', file.caption ?? '');
  }

  async login(prompts: LoginPrompts): Promise<TgUser> {
    this.calls.push('login');
    await this.storage.driver.load?.();
    // The auth key is the TRANSPORT key: mtcute creates it in the DH handshake on connect, before
    // anyone typed a phone number (`SessionConnection.onConnected` → `_authorize`). A login that
    // then fails still leaves it in the file — it says nothing about a sign-in.
    await this.storage.authKeys.set(2, new Uint8Array([1, 2, 3, 4, 250, 251]));
    const phone = await prompts.phone();
    const code = await prompts.code();
    if (!phone || !code) throw new Error('PHONE_CODE_EMPTY');
    const password = await prompts.password();
    if (password !== 'correct horse') throw new Error('PASSWORD_HASH_INVALID');
    // What the sign-in itself leaves: `notifyLoggedIn` → `CurrentUserService.store` writes the
    // user and saves the driver at once.
    const me = this.script.loginAs ?? ME;
    await this.storage.kv.set('current_user', new Uint8Array([1, 0, 0, 0, me.id]));
    await this.storage.kv.set('dc', new Uint8Array([2]));
    await this.storage.driver.save?.();
    if (this.script.failAfterSignIn) throw new Error(this.script.failAfterSignIn);
    return me;
  }

  async destroy(): Promise<void> {
    this.destroyed++;
    await this.storage.driver.save?.();
  }
}

/** A factory that records every client it made. */
export function fakeFactory(script: FakeScript): {
  clients: FakeClient[];
  create: (o: ClientOptions) => FakeClient;
} {
  const clients: FakeClient[] = [];
  return {
    clients,
    create: (options) => {
      const client = new FakeClient(options, script);
      clients.push(client);
      return client;
    },
  };
}
