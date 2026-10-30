/**
 * The XMPP backend — a `chat` driver behind the same port as every other backend, loaded only
 * through the registry.
 */

import { _, fmt } from '@curlew/protocol';
import type {
  AccountPrompter,
  BackendAccount,
  BackendContext,
  ChatBackend,
  ChatConnectOptions,
  ChatSession,
  MessageSender,
  SendBackend,
} from '@curlew/protocol';
import { SecretStore } from '@curlew/store';
import { accountPath, caFileSetting, listAccounts, readLogin, refuseConfigSecrets } from './accounts.ts';
import type { LoginPrompts, XmppApi } from './api.ts';
import { requireArchive } from './archive.ts';
import {
  type ClientFactory,
  createXmppClient,
  createXmppLink,
  type LinkFactory,
  readOnly,
  type XmppLogin,
} from './client.ts';
import { GrantedXmppSession, type SendPermit } from './granted.ts';
import { MESSAGES } from './messages.ts';
import { loginXmpp } from './login.ts';
import { XMPP_MANIFEST } from './manifest.ts';
import { openOmemo, type OmemoSession } from './omemo-session.ts';
import { XmppSender } from './sender.ts';
import { XmppChatSession } from './session.ts';

/** The login questions, asked through whatever frontend is running. */
export function xmppPrompts(prompter: AccountPrompter): LoginPrompts {
  return {
    jid: () => prompter.ask(_('XMPP address (name@example.org)')),
    password: () => prompter.ask(_('Password'), { secret: true }),
    service: () =>
      prompter.ask(_('Server address — empty to discover it (e.g. xmpps://xmpp.example.org:5223, wss://…)')),
    notify: (message) => prompter.notify(message),
  };
}

export class XmppBackend implements ChatBackend, SendBackend {
  readonly manifest = XMPP_MANIFEST;
  readonly kind = 'chat' as const;
  private readonly context: BackendContext;
  private readonly createClient: ClientFactory;
  private readonly createLink: LinkFactory;

  /**
   * Two factories on purpose: the sync path gets a connection typed read-only, the grant-opened
   * path one that can write. A test injects a fake of each.
   */
  constructor(
    context: BackendContext,
    createClient: ClientFactory = createXmppClient,
    createLink: LinkFactory = createXmppLink,
  ) {
    this.context = context;
    this.createClient = createClient;
    this.createLink = createLink;
  }

  async listAccounts(): Promise<BackendAccount[]> {
    return listAccounts(this.context.secretsDir);
  }

  addAccount(prompter: AccountPrompter): Promise<BackendAccount> {
    return loginXmpp(this.context, xmppPrompts(prompter), this.createClient);
  }

  async connect(accountId: string, options?: ChatConnectOptions): Promise<ChatSession> {
    refuseConfigSecrets(this.context.settings);
    const login = readLogin(this.context.secretsDir, accountId);
    if (options?.decrypt === true) return this.connectDecrypting(accountId, login);
    const api = await this.createClient({ login, caFile: caFileSetting(this.context.settings) });
    try {
      await requireArchive(api);
    } catch (err) {
      await api.close().catch(() => {});
      throw err;
    }
    return new XmppChatSession(api);
  }

  /**
   * The same sync session, reading the account's OMEMO state — only for a caller that holds
   * `xmpp.omemo` (`ChatConnectOptions.decrypt`).
   *
   * A LINK rather than a client, because keeping the device current PUBLISHES. The session still
   * gets the read-only face of it, so decrypting cannot become sending by accident: the only
   * writes this path can make are the PEP round trips `openOmemo` does before the session exists.
   */
  private async connectDecrypting(accountId: string, login: XmppLogin): Promise<ChatSession> {
    const link = await this.createLink({ login, caFile: caFileSetting(this.context.settings) });
    const store = SecretStore.open(accountPath(this.context.secretsDir, accountId));
    let omemo: OmemoSession;
    try {
      await requireArchive(link);
      omemo = await openOmemo(link, store, link.jid);
    } catch (err) {
      store.close();
      await link.close().catch(() => {});
      throw err;
    }
    // The store is the session's for as long as it lives: the ratchet is read and written per
    // page, and `BEGIN IMMEDIATE` on it is what another process queues on (ADR 0006 §4).
    const api: XmppApi = {
      ...readOnly(link),
      close: async () => {
        store.close();
        await link.close();
      },
    };
    return new XmppChatSession(api, omemo.decrypt);
  }

  /**
   * Open the handle that may write. The caller (the app) has checked the grants and passes what
   * they allow for this account; without a permit there is no way to get here.
   */
  async openGranted(
    accountId: string,
    permit: SendPermit,
    options?: ChatConnectOptions,
  ): Promise<GrantedXmppSession> {
    refuseConfigSecrets(this.context.settings);
    if (!(await this.listAccounts()).some((a) => a.id === accountId)) {
      throw new Error(MESSAGES.noAccount(accountId));
    }
    const login = readLogin(this.context.secretsDir, accountId);
    const link = await this.createLink({ login, caFile: caFileSetting(this.context.settings) });
    if (options?.decrypt !== true) return new GrantedXmppSession(link, permit);

    const store = SecretStore.open(accountPath(this.context.secretsDir, accountId));
    let omemo: OmemoSession;
    try {
      omemo = await openOmemo(link, store, link.jid, {
        ...(options?.requireEncryption === undefined
          ? {}
          : { requireEncryption: options.requireEncryption }),
      });
    } catch (err) {
      store.close();
      await link.close().catch(() => {});
      throw err;
    }
    return new GrantedXmppSession(link, permit, undefined, {
      decrypt: omemo.decrypt,
      encrypt: (to, text) => omemo.encrypt(to, text),
      close: () => store.close(),
    });
  }

  /**
   * The send port (ADR 0004, amended 2026-10-30): the same granted handle, seen generically.
   * XMPP's own shape stays on `openGranted`; nothing above this line needs to know it.
   */
  async openSender(
    accountId: string,
    permit: SendPermit,
    options?: ChatConnectOptions,
  ): Promise<MessageSender> {
    return new XmppSender(await this.openGranted(accountId, permit, options));
  }
}
