/**
 * The Telegram backend — a `chat` driver behind the same port as every other backend, loaded
 * only through the registry.
 */

import {
  _,
  type AccountAddOptions,
  type AttachmentFetcher,
  type AccountPrompter,
  type BackendAccount,
  type BackendContext,
  type ChatBackend,
  type ChatSession,
  fmt,
  type MessageSender,
  type SendBackend,
  type SendPermit,
} from '@curlew/protocol';
import { SecretStore } from '@curlew/store';
import { existsSync } from 'node:fs';
import type { LoginPrompts, TelegramApi, TelegramClientHandle } from './api.ts';
import { isOwnChatId, listSessionAccounts, sessionPath } from './accounts.ts';
import { type ClientFactory, createMtcuteClient, sessionGone } from './client.ts';
import { embeddedCredentials, resolveCredentials, type TelegramCredentials } from './credentials.ts';
import { loginTelegram } from './login.ts';
import { TELEGRAM_MANIFEST } from './manifest.ts';
import { TelegramAttachments } from './attachments.ts';
import { TelegramSender } from './sender.ts';
import { TelegramChatSession } from './session.ts';
import { SecretStoreStorage } from './storage.ts';

/**
 * The tail every unusable-session error ends on.
 *
 * A function, not a `const`: a module-level `_()` would resolve while the module graph is still
 * being built — before `initI18n()` runs — and pin English in for the whole process.
 */
export const reloginHint = (): string => _('log in again with `curlew accounts add telegram`');

let warnedNoLive = false;

/**
 * A client made with `live: true` carries the update stream; one that does not — a build or a
 * factory without it — leaves the follow unable to wake. Say so ONCE per process: the follow
 * reconnects, and an account that cannot be followed is a degraded mode, not a silent one.
 * The line names no account and carries no secret.
 */
function warnNoLive(): void {
  if (warnedNoLive) return;
  warnedNoLive = true;
  console.warn(
    _('Telegram live updates are unavailable in this build: the follow will not wake on new messages'),
  );
}

/** The client, plus closing the session file once mtcute has saved into it. */
function withStoreClose(client: TelegramClientHandle, store: SecretStore): TelegramApi {
  return {
    getMe: () => client.getMe(),
    iterDialogs: (params) => client.iterDialogs(params),
    getHistory: (chatId, params) => client.getHistory(chatId, params),
    getMessages: (chatId, messageIds) => client.getMessages(chatId, messageIds),
    openMedia: (chatId, messageId) => client.openMedia(chatId, messageId),
    destroy: async () => {
      try {
        await client.destroy();
      } finally {
        store.close();
      }
    },
  };
}

/** Telegram's three login questions, asked through whatever frontend is running. */
export function telegramPrompts(prompter: AccountPrompter): LoginPrompts {
  return {
    // TRANSLATORS: `api_id` and `api_hash` are Telegram's own field names — do not translate them,
    // the user has to recognise them on my.telegram.org.
    apiId: () => prompter.ask(_('api_id of your Telegram app (from my.telegram.org)')),
    apiHash: () => prompter.ask(_('api_hash of that app'), { secret: true }),
    phone: () => prompter.ask(_('Phone number of the Telegram account (international, e.g. +49…)')),
    code: () => prompter.ask(_('Login code Telegram sent you')),
    password: () => prompter.ask(_('Two-step verification password'), { secret: true }),
    notify: (message) => prompter.notify(message),
  };
}

/** One open Telegram connection the daemon keeps: updates as wake-ups, a fresh read-only session per catch-up. */
export interface TelegramLiveConnection {
  chatSession(): ChatSession;
  onArrival(listener: () => void): () => void;
  onClosed(listener: (reason: string, loggedOut: boolean) => void): void;
  close(): Promise<void>;
}

/** The session is gone for good (revoked, deactivated): a follow stops the account instead of retrying. */
export class TelegramLoggedOutError extends Error {
  readonly loggedOut = true;
  constructor(message: string) {
    super(message);
    this.name = 'TelegramLoggedOutError';
  }
}

export class TelegramBackend implements ChatBackend, SendBackend {
  readonly manifest = TELEGRAM_MANIFEST;
  readonly kind = 'chat' as const;
  private readonly context: BackendContext;
  private readonly createClient: ClientFactory;

  private readonly embedded: TelegramCredentials | null;

  constructor(
    context: BackendContext,
    createClient: ClientFactory = createMtcuteClient,
    embedded: TelegramCredentials | null = embeddedCredentials(),
  ) {
    this.context = context;
    this.createClient = createClient;
    this.embedded = embedded;
  }

  async listAccounts(): Promise<BackendAccount[]> {
    return listSessionAccounts(this.context.secretsDir);
  }

  /** The account's own user id, the chat id of its "Saved Messages". */
  async isSelfAddress(accountId: string, to: string): Promise<boolean> {
    return isOwnChatId(accountId, to);
  }

  /** Log in: phone number, the code Telegram sends, and the 2FA password when one is set. */
  addAccount(prompter: AccountPrompter, options?: AccountAddOptions): Promise<BackendAccount> {
    return loginTelegram(this.context, telegramPrompts(prompter), this.createClient, options, this.embedded);
  }

  async connect(accountId: string): Promise<ChatSession> {
    const { api } = await this.open(accountId);
    // `api` is the read-only wrapper; the full handle (with `sendText`) is never given to a session,
    // so sync and the read tools cannot send.
    return new TelegramChatSession(api);
  }

  /**
   * The connection a follow keeps open (ADR 0002 §4): updates only wake the caller, and every
   * catch-up reads through a session over the same read-only wrapper `connect` hands out, so a
   * follow cannot send either. The caller holds the receive lease.
   */
  async connectLive(accountId: string): Promise<TelegramLiveConnection> {
    const { client, api } = await this.open(accountId, true);
    const live = client.live;
    if (!live) warnNoLive();
    try {
      await live?.start();
    } catch (err) {
      await api.destroy().catch(() => {});
      throw err;
    }
    return {
      chatSession: () => new TelegramChatSession(api),
      onArrival: (listener) => live?.onArrival(listener) ?? (() => {}),
      onClosed: (listener) => live?.onClosed((end) => listener(end.reason, end.loggedOut)),
      close: () => api.destroy(),
    };
  }

  /** The only way to get `sendText`: the full handle, behind a permit. */
  async openSender(accountId: string, permit: SendPermit): Promise<MessageSender> {
    const { client, api } = await this.open(accountId);
    return new TelegramSender(client, permit, () => api.destroy());
  }

  /** The read-only download handle: it reads one message again and streams its media, nothing else. */
  async openAttachments(accountId: string): Promise<AttachmentFetcher> {
    const { api } = await this.open(accountId);
    return new TelegramAttachments(api);
  }

  /** Open the session file, connect and prove the session is still authorized. */
  private async open(accountId: string, live = false): Promise<{ client: TelegramClientHandle; api: TelegramApi }> {
    const path = sessionPath(this.context.secretsDir, accountId);
    if (!existsSync(path)) {
      throw new Error(
        fmt(_('no Telegram session for {account} — {hint}'), { account: accountId, hint: reloginHint() }),
      );
    }
    const store = SecretStore.open(path);
    let client: TelegramClientHandle;
    let api: TelegramApi;
    try {
      client = this.createClient({
        credentials: resolveCredentials(this.context, store, this.embedded),
        storage: new SecretStoreStorage(store),
        ...(live ? { live } : {}),
      });
      // The store belongs to the client from here on: `withStoreClose` closes it with the client,
      // so every path out of the try below goes through `api.destroy()` and not through here.
      api = withStoreClose(client, store);
    } catch (err) {
      store.close();
      throw err;
    }
    try {
      await client.connect();
      // Proves the session is still authorized before any chat is touched: a session revoked
      // from another device fails here with one clear message instead of once per chat.
      await client.getMe();
    } catch (err) {
      await api.destroy().catch(() => {});
      const message = fmt(_('the Telegram session {account} is not usable ({reason}) — {hint}'), {
        account: accountId,
        reason: err instanceof Error ? err.message : String(err),
        hint: reloginHint(),
      });
      throw sessionGone(err) !== null ? new TelegramLoggedOutError(message) : new Error(message);
    }
    return { client, api };
  }
}
