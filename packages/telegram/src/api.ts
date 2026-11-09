/**
 * The slice of mtcute's `TelegramClient` curlew uses — and nothing else.
 *
 * Structural on purpose: mtcute's own classes (`User`, `Chat`, `Dialog`, `Message`) satisfy these
 * shapes, and so does a plain object in a test. That is what lets the mapping and the session be
 * unit-tested on Node and GJS against recorded, synthetic data, with no network and no account.
 *
 * `TelegramApi` is read-only by construction: no method here can send, edit, delete or mark anything
 * read. Sending exists only on `TelegramClientHandle`, which the sync path never receives (see there).
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

/**
 * What a message carries, as far as curlew reads it. Only `type` is always there; the rest is
 * what mtcute's media classes report when they have it (a photo has no name or MIME type, a
 * voice note has a duration).
 */
export interface TgMedia {
  /** mtcute's discriminator: `photo`, `video`, `audio`, `voice`, `document`, `sticker`, `webpage`, … */
  readonly type: string;
  readonly fileName?: string | null | undefined;
  readonly mimeType?: string | null | undefined;
  /** Bytes, when Telegram announced them. */
  readonly fileSize?: number | null | undefined;
  readonly width?: number | null | undefined;
  readonly height?: number | null | undefined;
  /** Seconds. */
  readonly duration?: number | null | undefined;
}

/** A media file being downloaded: what the message says it is, and its bytes in order. */
export interface TgMediaDownload {
  readonly media: TgMedia;
  readonly chunks: AsyncIterable<Uint8Array>;
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
  readonly media: TgMedia | null;
  readonly replyToMessage: TgRepliedMessage | null;
  readonly isTopicMessage: boolean;
  /** Shared by the messages of one album; null for a message that is not part of one. */
  readonly groupedIdUnique?: string | null;
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
  /**
   * The media of one message, downloaded. Null when the message or its file is gone. It reads
   * the message again instead of keeping a file reference, because those expire.
   */
  openMedia(chatId: number, messageId: number): Promise<TgMediaDownload | null>;
  destroy(): Promise<void>;
}

/**
 * The live side of a client that keeps listening (the daemon's follow, ADR 0002 §4). Only a
 * WAKE-UP, like `MatrixLive`: no update carries content out, the caller reads through the same
 * history walk `curlew sync` runs. Nothing here can send, edit or mark anything read.
 */
export interface TelegramLive {
  /** Start receiving updates. Called once, after `connect()` proved the session. */
  start(): Promise<void>;
  /** Called when an update that may carry a new, edited or deleted message arrived. */
  onArrival(listener: () => void): () => void;
  /**
   * Called once when this connection will not recover by itself. `loggedOut` is Telegram saying
   * the session is gone (revoked, deactivated): retrying cannot help. `reason` is a name, never
   * Telegram's message.
   */
  onClosed(listener: (end: { reason: string; loggedOut: boolean }) => void): void;
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

/** A file to upload: its bytes, name and type. */
export interface TgOutgoingFile {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly contentType: string;
  readonly caption?: string;
  readonly asPhoto: boolean;
}

/**
 * A full client: the read API plus connecting, logging in and — the writes — `sendText` and `sendFile`. What a
 * `ClientFactory` returns.
 *
 * `sendText` lives here and NOT on `TelegramApi` on purpose: `TelegramBackend.connect()` wraps the
 * client in `withStoreClose`, which copies only the named read methods, so the `ChatSession` that
 * sync and the read tools hold has no way to send. Only `TelegramBackend.openSender()` keeps the
 * full handle, and only behind a `SendPermit` (ADR 0004).
 */
export interface TelegramClientHandle extends TelegramApi {
  /** Send ONE plain-text message to the chat (a marked id, as in `TgPeer.id`); returns it as sent. */
  sendText(chatId: number, text: string): Promise<TgMessage>;
  /**
   * Send ONE file, optionally with a caption. `asPhoto` sends a picture as a photo (Telegram
   * recompresses it, as every chat app does) instead of as a document.
   */
  sendFile(chatId: number, file: TgOutgoingFile): Promise<TgMessage>;
  connect(): Promise<void>;
  /** Present only on a client made with `live: true`. */
  readonly live?: TelegramLive;
  /** Log in (phone → code → optional 2FA password) and return the logged-in user. */
  login(prompts: LoginPrompts): Promise<TgUser>;
}
