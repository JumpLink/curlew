/**
 * The Telegram backend — a `chat` driver behind the same port as every other backend, loaded
 * only through the registry.
 */

import {
  _,
  type AccountAddOptions,
  type AccountPrompter,
  type BackendAccount,
  type BackendContext,
  type ChatBackend,
  type ChatSession,
  fmt,
} from '@curlew/protocol';
import { SecretStore } from '@curlew/store';
import { existsSync } from 'node:fs';
import type { LoginPrompts, TelegramApi, TelegramClientHandle } from './api.ts';
import { listSessionAccounts, sessionPath } from './accounts.ts';
import { type ClientFactory, createMtcuteClient } from './client.ts';
import { embeddedCredentials, resolveCredentials, type TelegramCredentials } from './credentials.ts';
import { loginTelegram } from './login.ts';
import { TELEGRAM_MANIFEST } from './manifest.ts';
import { TelegramChatSession } from './session.ts';
import { SecretStoreStorage } from './storage.ts';

/**
 * The tail every unusable-session error ends on.
 *
 * A function, not a `const`: a module-level `_()` would resolve while the module graph is still
 * being built — before `initI18n()` runs — and pin English in for the whole process.
 */
export const reloginHint = (): string => _('log in again with `curlew accounts add telegram`');

/** The client, plus closing the session file once mtcute has saved into it. */
function withStoreClose(client: TelegramClientHandle, store: SecretStore): TelegramApi {
  return {
    getMe: () => client.getMe(),
    iterDialogs: (params) => client.iterDialogs(params),
    getHistory: (chatId, params) => client.getHistory(chatId, params),
    getMessages: (chatId, messageIds) => client.getMessages(chatId, messageIds),
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

export class TelegramBackend implements ChatBackend {
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

  /** Log in: phone number, the code Telegram sends, and the 2FA password when one is set. */
  addAccount(prompter: AccountPrompter, options?: AccountAddOptions): Promise<BackendAccount> {
    return loginTelegram(this.context, telegramPrompts(prompter), this.createClient, options, this.embedded);
  }

  async connect(accountId: string): Promise<ChatSession> {
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
      throw new Error(
        fmt(_('the Telegram session {account} is not usable ({reason}) — {hint}'), {
          account: accountId,
          reason: err instanceof Error ? err.message : String(err),
          hint: reloginHint(),
        }),
      );
    }
    return new TelegramChatSession(api);
  }
}
