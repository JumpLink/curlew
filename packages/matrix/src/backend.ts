/**
 * The Matrix backend — a `chat` driver behind the same port as every other backend, loaded
 * only through the registry.
 */

import { _, fmt, visibleAccounts } from '@curlew/protocol';
import type {
  AccountPrompter,
  AttachmentFetcher,
  BackendAccount,
  ListAccountsOptions,
  BackendContext,
  ChatBackend,
  ChatSession,
  MessageSender,
  SendBackend,
  SendPermit,
} from '@curlew/protocol';
import { removeSecretFiles, SecretStore } from '@curlew/store';
import { existsSync } from 'node:fs';
import type { MatrixApi, MatrixLoginPrompts } from './api.ts';
import {
  type AccountRecord,
  accountPath,
  isOwnUserId,
  listAccounts,
  readAccessToken,
  readAccountRecord,
  secretStoreLedger,
} from './accounts.ts';
import { connectMatrixClient, isLoggedOutError, type MatrixConnector } from './client.ts';
import { MatrixAttachments } from './attachments.ts';
import { readOnlyFetch, sendFetch } from './guard.ts';
import { loginMatrix } from './login.ts';
import { reportUndecryptable } from './redact.ts';
import { MATRIX_MANIFEST } from './manifest.ts';
import { matrixSendApi, MatrixSender } from './send.ts';
import { MatrixChatSession } from './session.ts';

/** A Matrix account whose token the server no longer knows: the daemon stops it instead of retrying. */
export class MatrixLoggedOutError extends Error {
  readonly loggedOut = true;
  constructor(message: string) {
    super(message);
    this.name = 'MatrixLoggedOutError';
  }
}

/** One open Matrix connection the daemon keeps (ADR 0007 §5): a sync loop plus fresh history walks. */
export interface MatrixLiveConnection {
  /** A new session over the open client; closing it leaves the client running. */
  chatSession(): ChatSession;
  onArrival(listener: () => void): () => void;
  onClosed(listener: (reason: string, loggedOut: boolean) => void): void;
  close(): Promise<void>;
}

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

export class MatrixBackend implements ChatBackend, SendBackend {
  readonly manifest = MATRIX_MANIFEST;
  readonly kind = 'chat' as const;
  private readonly context: BackendContext;
  private readonly connectClient: MatrixConnector;
  private readonly httpFetch: typeof globalThis.fetch;

  constructor(
    context: BackendContext,
    connectClient: MatrixConnector = connectMatrixClient,
    httpFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.context = context;
    this.connectClient = connectClient;
    // The send path's transport, injected by tests. It is wrapped per permit in `openSender` and
    // never handed out unwrapped.
    this.httpFetch = httpFetch;
  }

  async listAccounts(options?: ListAccountsOptions): Promise<BackendAccount[]> {
    return visibleAccounts(this.context, listAccounts(this.context.secretsDir), options);
  }

  /** Unlink: the stored session goes, the indexed messages stay. */
  async removeAccount(accountId: string): Promise<void> {
    const path = accountPath(this.context.secretsDir, accountId);
    removeSecretFiles(path);
  }

  /** The account's own user id (a room is never self; see `isOwnUserId`). */
  async isSelfAddress(accountId: string, to: string): Promise<boolean> {
    const account = (await this.listAccounts()).find((a) => a.id === accountId);
    return account !== undefined && isOwnUserId(account.identity, to);
  }

  /** Log in with homeserver, user and password; SSO-only servers are refused with the reason. */
  addAccount(prompter: AccountPrompter): Promise<BackendAccount> {
    return loginMatrix(this.context, matrixPrompts(prompter), this.connectClient);
  }

  /** Open the account's secret file and read what a session needs from it. */
  private openAccount(accountId: string): {
    store: SecretStore;
    record: AccountRecord;
    accessToken: string;
  } {
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
    return { store, record, accessToken };
  }

  /**
   * The only way to get a send path: one PUT endpoint, for the permit's rooms only.
   *
   * No matrix-js-sdk, no sync and no crypto store — a send needs the homeserver URL and the
   * access token, nothing else. The read session built by `connect` has no sender and no way to
   * reach one: its fetch is `readOnlyFetch`, which refuses the send PUT for every room.
   */
  async openSender(accountId: string, permit: SendPermit): Promise<MessageSender> {
    const { store, record, accessToken } = this.openAccount(accountId);
    const api = matrixSendApi({
      homeserver: record.homeserver,
      accessToken,
      userId: record.userId,
      fetch: sendFetch(this.httpFetch, permit.addresses),
    });
    return new MatrixSender(api, permit, async () => {
      store.close();
    });
  }

  /**
   * The read-only download handle: plain GETs for media, through the read-only gate. Like
   * `openSender` it needs no sync and no crypto store, only the homeserver and the token.
   */
  async openAttachments(accountId: string): Promise<AttachmentFetcher> {
    const { store, record, accessToken } = this.openAccount(accountId);
    return new MatrixAttachments({
      homeserver: record.homeserver,
      accessToken,
      fetch: readOnlyFetch(this.httpFetch),
      onClose: () => store.close(),
    });
  }

  /** Open the account's client; the SDK's error text names the errcode, never the token. */
  private async openClient(accountId: string): Promise<{ store: SecretStore; api: MatrixApi; record: AccountRecord }> {
    const { store, record, accessToken } = this.openAccount(accountId);
    try {
      const api = await this.connectClient({ ...record, accessToken, store, accountId });
      return { store, api, record };
    } catch (err) {
      store.close();
      // M_UNKNOWN_TOKEN is a device logged out elsewhere.
      const message = fmt(_('the Matrix account {account} is not usable ({reason}) — {hint}'), {
        account: record.userId,
        reason: err instanceof Error ? err.message : String(err),
        hint: reloginHint(),
      });
      throw isLoggedOutError(err) ? new MatrixLoggedOutError(message) : new Error(message);
    }
  }

  /**
   * The connection a follow keeps open: the client's sync loop stays up after the first response,
   * and every catch-up reads history through a session of its own (a session caches its walks, a
   * stale cache would hide what arrived since). Closing that session does not stop the client.
   */
  async connectLive(accountId: string): Promise<MatrixLiveConnection> {
    const { store, api } = await this.openClient(accountId);
    const live = api.live;
    return {
      chatSession: () =>
        new MatrixChatSession(
          {
            userId: api.userId,
            listRooms: () => api.listRooms(),
            messages: (roomId, from, limit) => api.messages(roomId, from, limit),
            fetchEvent: (roomId, eventId) => api.fetchEvent(roomId, eventId),
            close: async () => {
              reportUndecryptable();
            },
          },
          secretStoreLedger(store),
        ),
      onArrival: (listener) => live?.onArrival(listener) ?? (() => {}),
      onClosed: (listener) => live?.onClosed((end) => listener(end.reason, end.loggedOut)),
      close: async () => {
        try {
          await api.close();
        } finally {
          store.close();
        }
      },
    };
  }

  async connect(accountId: string): Promise<ChatSession> {
    const { store, api: connected } = await this.openClient(accountId);
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
            reportUndecryptable();
            store.close();
          }
        },
      },
      secretStoreLedger(store),
    );
  }
}
