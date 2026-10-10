import type {
  ClientOptions,
  LoginPrompts,
  TelegramClientHandle,
  TgChat,
  TgDialog,
  TgDialogsParams,
  TgMessage,
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
   * Reject the login AFTER Telegram accepted the sign-in and mtcute recorded the user — what
   * happens when the bookkeeping after `notifyLoggedIn` (the update manager, `start`'s own
   * follow-up calls) throws. The session is authorized at that point and must not be thrown away.
   */
  failAfterSignIn?: string;
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

  constructor(options: ClientOptions, script: FakeScript) {
    this.storage = options.storage;
    this.credentials = options.credentials;
    this.script = script;
  }

  async connect(): Promise<void> {
    this.calls.push('connect');
    await this.storage.driver.load?.();
  }

  async getMe(): Promise<TgUser> {
    this.calls.push('getMe');
    if (this.script.unauthorized) throw new Error('AUTH_KEY_UNREGISTERED');
    return ME;
  }

  async *iterDialogs(params?: TgDialogsParams): AsyncIterable<TgDialog> {
    // The archived handling is recorded, because it is a REAL behaviour of mtcute: the default
    // ('exclude') never returns an archived chat, and a test that does not look here cannot tell
    // a session that asked for both folders from one that forgot to ask.
    this.calls.push(`iterDialogs:${params?.archived ?? 'default'}`);
    this.dialogsParams.push(params);
    for (const dialog of this.script.dialogs ?? []) yield dialog;
  }

  async getHistory(
    chatId: number,
    params: { limit: number; offset?: { id: number; date: number }; reverse?: boolean },
  ): Promise<ReadonlyArray<TgMessage>> {
    this.calls.push(
      `getHistory:${chatId}:${params.reverse ? `rev@${params.offset?.id}` : 'newest'}:${params.limit}`,
    );
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
    // mtcute's contract: one slot per asked id, IN ORDER, `null` where Telegram has no message.
    const all = this.script.history?.get(chatId) ?? [];
    const byId = new Map(all.map((m) => [m.id, m]));
    return messageIds.slice(0, SERVER_HISTORY_CAP).map((id) => byId.get(id) ?? null);
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
