/**
 * The slice of mtcute's `TelegramClient` curlew uses — and nothing else.
 *
 * Structural on purpose: mtcute's own classes (`User`, `Chat`, `Dialog`, `Message`) satisfy these
 * shapes, and so does a plain object in a test. That is what lets the mapping and the session be
 * unit-tested on Node and GJS against recorded, synthetic data, with no network and no account.
 *
 * Read-only by construction: no method here can send, edit, delete or mark anything read.
 */

export interface TgUser {
  readonly type: 'user';
  /** The user id (positive). */
  readonly id: number;
  readonly username: string | null;
  /** Digits without `+`, as Telegram reports it — only when the user shares it with you. */
  readonly phoneNumber: string | null;
  readonly displayName: string;
  readonly isBot: boolean;
  readonly isSelf: boolean;
}

export interface TgChat {
  readonly type: 'chat';
  /** The MARKED id (negative for groups and channels). */
  readonly id: number;
  readonly chatType: string;
  readonly displayName: string;
  readonly username: string | null;
}

export type TgPeer = TgUser | TgChat;

export interface TgRepliedMessage {
  readonly id: number | null;
  readonly threadId: number | null;
}

export interface TgMessage {
  readonly id: number;
  readonly date: Date;
  readonly editDate: Date | null;
  readonly sender: TgPeer | { readonly type: 'anonymous' };
  readonly chat: TgPeer;
  readonly isOutgoing: boolean;
  /** Joins, pins, title changes — notices, not something a person wrote. */
  readonly isService: boolean;
  readonly text: string;
  readonly media: { readonly type: string } | null;
  readonly replyToMessage: TgRepliedMessage | null;
  readonly isTopicMessage: boolean;
}

export interface TgDialog {
  readonly peer: TgPeer;
  readonly lastMessage: TgMessage | null;
  /** Everything at or below this id was read by the user. */
  readonly lastReadIngoing: number;
  /** Everything the user sent at or below this id was read by the other side. */
  readonly lastReadOutgoing: number;
}

/**
 * How to walk the dialog list. Mirrors the slice of mtcute's `iterDialogs` params curlew uses.
 *
 * `archived` is the one that matters: mtcute's own default is `'exclude'`, which asks Telegram
 * for the MAIN folder only, so an archived chat is not merely unlisted — it never reaches curlew
 * at all. curlew is a read-only index of everything the account can see, so it asks for `'keep'`
 * (mtcute then leaves `folder_id` unset, which is what makes Telegram return BOTH folders).
 */
export interface TgDialogsParams {
  /**
   * `'keep'` for both the main and the archive folder, `'exclude'` for the main folder only
   * (mtcute's default), `'only'` for the archive.
   */
  archived?: 'keep' | 'exclude' | 'only';
}

export interface TelegramApi {
  getMe(): Promise<TgUser>;
  /** Every dialog, most recently active first. */
  iterDialogs(params?: TgDialogsParams): AsyncIterable<TgDialog>;
  /**
   * mtcute's `getHistory`: newest first by default; without `reverse` it is newest first and, with
   * an offset, strictly below `offset.id`. With `reverse` oldest first, starting AT `offset.id`
   * (inclusive). A single call returns at most 100.
   */
  getHistory(
    chatId: number,
    params: { limit: number; offset?: { id: number; date: number }; reverse?: boolean },
  ): Promise<ReadonlyArray<TgMessage>>;
  /**
   * mtcute's `getMessages`: the messages at those ids, **one slot per asked id, in order**, with
   * `null` where Telegram has no message — which for an id this account once saw is positive
   * proof it was deleted. At most 100 ids per call.
   *
   * The id array is mutable on purpose: mtcute's own signature takes `number | number[]`, and
   * mtcute's client satisfies this interface structurally (see `client.ts`).
   */
  getMessages(chatId: number, messageIds: number[]): Promise<ReadonlyArray<TgMessage | null>>;
  destroy(): Promise<void>;
}

/** What the interactive login asks the user for. Each is called only when Telegram needs it. */
export interface LoginPrompts {
  /** Your own app's api_id and api_hash — asked only when the environment does not set them. */
  apiId(): Promise<string>;
  apiHash(): Promise<string>;
  phone(): Promise<string>;
  code(): Promise<string>;
  /** Only asked for an account with two-step verification. */
  password(): Promise<string>;
  /** Progress for the user ("code sent via the Telegram app"). Never carries a secret. */
  notify(message: string): void;
}

/** A full client: the read API plus connecting and logging in. What a `ClientFactory` returns. */
export interface TelegramClientHandle extends TelegramApi {
  connect(): Promise<void>;
  /** Log in (phone → code → optional 2FA password) and return the logged-in user. */
  login(prompts: LoginPrompts): Promise<TgUser>;
}
