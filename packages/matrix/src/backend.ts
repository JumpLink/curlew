/**
 * The Matrix backend — a `chat` driver behind the same port as every other backend, loaded
 * only through the registry.
 */

import { _, fmt } from '@curlew/protocol';
import type {
  AccountPrompter,
  BackendAccount,
  BackendContext,
  ChatBackend,
  ChatSession,
} from '@curlew/protocol';
import { SecretStore } from '@curlew/store';
import { existsSync } from 'node:fs';
import type { MatrixLoginPrompts } from './api.ts';
import {
  accountPath,
  listAccounts,
  readAccessToken,
  readAccountRecord,
  secretStoreLedger,
} from './accounts.ts';
import { connectMatrixClient, type MatrixConnector } from './client.ts';
import { loginMatrix } from './login.ts';
import { MATRIX_MANIFEST } from './manifest.ts';
import { MatrixChatSession } from './session.ts';

export const reloginHint = (): string => _('log in again with `curlew accounts add matrix`');

/** The login questions, asked through whatever frontend is running. */
export function matrixPrompts(prompter: AccountPrompter): MatrixLoginPrompts {
  return {
    homeserver: () => prompter.ask(_('Homeserver (URL like https://matrix.example.org, or the server name)')),
    user: () => prompter.ask(_('Matrix user (@name:example.org)')),
    password: () => prompter.ask(_('Password'), { secret: true }),
    notify: (message) => prompter.notify(message),
  };
}

export class MatrixBackend implements ChatBackend {
  readonly manifest = MATRIX_MANIFEST;
  readonly kind = 'chat' as const;
  private readonly context: BackendContext;
  private readonly connectClient: MatrixConnector;

  constructor(context: BackendContext, connectClient: MatrixConnector = connectMatrixClient) {
    this.context = context;
    this.connectClient = connectClient;
  }

  async listAccounts(): Promise<BackendAccount[]> {
    return listAccounts(this.context.secretsDir);
  }

  /** Log in with homeserver, user and password; SSO-only servers are refused with the reason. */
  addAccount(prompter: AccountPrompter): Promise<BackendAccount> {
    return loginMatrix(this.context, matrixPrompts(prompter), this.connectClient);
  }

  async connect(accountId: string): Promise<ChatSession> {
    const path = accountPath(this.context.secretsDir, accountId);
    if (!existsSync(path)) throw new Error(fmt(_('no Matrix account {account} — {hint}'), { account: accountId, hint: reloginHint() }));
    const store = SecretStore.open(path);
    const record = readAccountRecord(store);
    const accessToken = readAccessToken(store);
    if (!record || !accessToken) {
      store.close();
      throw new Error(
        fmt(_('the Matrix account file {account} is incomplete — {hint}'), { account: accountId, hint: reloginHint() }),
      );
    }
    let api;
    try {
      api = await this.connectClient({ ...record, accessToken, store, accountId });
    } catch (err) {
      store.close();
      // The SDK's error text names the server's errcode (M_UNKNOWN_TOKEN for a device logged out
      // elsewhere); it never carries the token.
      throw new Error(
        fmt(_('the Matrix account {account} is not usable ({reason}) — {hint}'), {
          account: record.userId,
          reason: err instanceof Error ? err.message : String(err),
          hint: reloginHint(),
        }),
      );
    }
    const connected = api;
    return new MatrixChatSession(
      {
        userId: connected.userId,
        listRooms: () => connected.listRooms(),
        messages: (roomId, from, limit) => connected.messages(roomId, from, limit),
        fetchEvent: (roomId, eventId) => connected.fetchEvent(roomId, eventId),
        close: async () => {
          try {
            await connected.close();
          } finally {
            store.close();
          }
        },
      },
      secretStoreLedger(store),
    );
  }
}
