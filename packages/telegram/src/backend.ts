/**
 * The Telegram backend — a `chat` driver behind the same port as every other backend, loaded
 * only through the registry.
 */

import type {
  AccountPrompter,
  BackendAccount,
  BackendContext,
  ChatBackend,
  ChatSession,
} from '@curlew/protocol';
import { SecretStore } from '@curlew/store';
import { existsSync } from 'node:fs';
import type { LoginPrompts, TelegramApi, TelegramClientHandle } from './api.ts';
import { listSessionAccounts, sessionPath } from './accounts.ts';
import { type ClientFactory, createMtcuteClient } from './client.ts';
import { resolveCredentials } from './credentials.ts';
import { loginTelegram } from './login.ts';
import { TELEGRAM_MANIFEST } from './manifest.ts';
import { TelegramChatSession } from './session.ts';
import { SecretStoreStorage } from './storage.ts';

export const RELOGIN_HINT = 'log in again with `curlew accounts add telegram`';

/** The client, plus closing the session file once mtcute has saved into it. */
function withStoreClose(client: TelegramClientHandle, store: SecretStore): TelegramApi {
  return {
    getMe: () => client.getMe(),
    iterDialogs: (params) => client.iterDialogs(params),
    getHistory: (chatId, params) => client.getHistory(chatId, params),
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
    apiId: () => prompter.ask('api_id of your own Telegram app (from my.telegram.org)'),
    apiHash: () => prompter.ask('api_hash of that app', { secret: true }),
    phone: () => prompter.ask('Phone number of the Telegram account (international, e.g. +49…)'),
    code: () => prompter.ask('Login code Telegram sent you'),
    password: () => prompter.ask('Two-step verification password', { secret: true }),
    notify: (message) => prompter.notify(message),
  };
}

export class TelegramBackend implements ChatBackend {
  readonly manifest = TELEGRAM_MANIFEST;
  readonly kind = 'chat' as const;
  private readonly context: BackendContext;
  private readonly createClient: ClientFactory;

  constructor(context: BackendContext, createClient: ClientFactory = createMtcuteClient) {
    this.context = context;
    this.createClient = createClient;
  }

  async listAccounts(): Promise<BackendAccount[]> {
    return listSessionAccounts(this.context.secretsDir);
  }

  /** Log in: phone number, the code Telegram sends, and the 2FA password when one is set. */
  addAccount(prompter: AccountPrompter): Promise<BackendAccount> {
    return loginTelegram(this.context, telegramPrompts(prompter), this.createClient);
  }

  async connect(accountId: string): Promise<ChatSession> {
    const path = sessionPath(this.context.secretsDir, accountId);
    if (!existsSync(path)) throw new Error(`no Telegram session for ${accountId} — ${RELOGIN_HINT}`);
    const store = SecretStore.open(path);
    let client: TelegramClientHandle;
    let api: TelegramApi;
    try {
      client = this.createClient({
        credentials: resolveCredentials(this.context, store),
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
        `the Telegram session ${accountId} is not usable (${err instanceof Error ? err.message : String(err)}) — ${RELOGIN_HINT}`,
      );
    }
    return new TelegramChatSession(api);
  }
}
