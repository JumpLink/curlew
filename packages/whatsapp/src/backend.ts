/**
 * The WhatsApp backend — a `delivery` driver behind the same port as every other backend,
 * loaded only through the registry, and only after its terms notice was accepted.
 *
 * It also serves the send port, but only there: `connect()` hands out a session that cannot
 * write, and `openSender()` is the one method that builds a sending socket — never without a
 * permit (ADR 0004).
 *
 * Self-contained on purpose (ADR 0001 §5): no other curlew package imports this one — only
 * the app's registry lists it — so it can move to its own repository in one step if a takedown
 * or a ban wave makes that necessary.
 */

import { _, fmt } from '@curlew/protocol';
import type {
  AccountPrompter,
  BackendAccount,
  BackendContext,
  DeliveryBackend,
  DeliveryConnectOptions,
  DeliverySession,
  MessageSender,
  SendBackend,
  SendPermit,
} from '@curlew/protocol';
import { SecretStore } from '@curlew/store';
import { existsSync } from 'node:fs';
import type { WaSendSocketHandle } from './api.ts';
import type { WaConnection } from './client.ts';
import { listSessionAccounts, sessionPath } from './accounts.ts';
import { SecretStoreAuthState } from './auth-state.ts';
import {
  type ConnectionFactory,
  createBaileysConnection,
  createBaileysSendSocket,
  type SendSocketFactory,
  type SocketFactory,
} from './client.ts';
import { guardedSendSocket } from './guard.ts';
import { JidResolver } from './jid.ts';
import { FileJournal, journalPath } from './journal.ts';
import { linkWhatsApp } from './login.ts';
import { WHATSAPP_MANIFEST } from './manifest.ts';
import { WhatsAppMapper } from './map.ts';
import { type ReceiverOptions, relinkHint, WhatsAppReceiver } from './receiver.ts';
import { WhatsAppSender } from './send.ts';

/** The non-secret settings this backend reads from `backends.whatsapp.settings`. */
export interface WhatsAppSettings {
  /** Ask the phone for the full history (not only recent months) when linking. */
  fullHistory: boolean;
}

export function parseSettings(settings: BackendContext['settings']): WhatsAppSettings {
  const known = new Set(['fullHistory']);
  const unknown = Object.keys(settings).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `unknown setting(s) for whatsapp: ${unknown.join(', ')} — the only one is fullHistory (true/false); the session keys live in the 0600 session file, never in the config`,
    );
  }
  const full = settings.fullHistory;
  if (full !== undefined && typeof full !== 'boolean')
    throw new Error('backends.whatsapp.settings.fullHistory must be true or false');
  return { fullHistory: full === true };
}

export interface WhatsAppBackendOptions {
  createSocket?: SocketFactory;
  /** The send socket — a separate factory, so a test cannot hand a sending socket to a sync. */
  createSendSocket?: SendSocketFactory;
  /**
   * The two-view connection `connect()` runs on, when the session should be able to send on it
   * (`DeliverySession.openSender`). Without it — and a test that overrides only `createSocket` is
   * exactly that case — the session gets a receive-only connection and cannot send, which is the
   * same fallback the app takes when no daemon is running.
   */
  createConnection?: ConnectionFactory;
  /** Receiver timing — tests shorten it. */
  receiver?: Omit<ReceiverOptions, 'mode'>;
  /** Auth-state write-behind delay. */
  flushDelayMs?: number;
  /** How long a send waits for WhatsApp's acknowledgement — tests shorten it. */
  sendAckMs?: number;
}

export class WhatsAppBackend implements DeliveryBackend, SendBackend {
  readonly manifest = WHATSAPP_MANIFEST;
  readonly kind = 'delivery' as const;
  private readonly context: BackendContext;
  private readonly options: WhatsAppBackendOptions;

  constructor(context: BackendContext, options: WhatsAppBackendOptions = {}) {
    this.context = context;
    this.options = options;
  }

  async listAccounts(): Promise<BackendAccount[]> {
    return listSessionAccounts(this.context.secretsDir);
  }

  /** Link curlew as a device: a QR code to scan, or a pairing code to type on the phone. */
  addAccount(prompter: AccountPrompter): Promise<BackendAccount> {
    const settings = parseSettings(this.context.settings);
    return linkWhatsApp(this.context, prompter, {
      createSocket: this.options.createSocket,
      fullHistory: settings.fullHistory,
    });
  }

  /**
   * Open the account's session file and its linked device — what both a sync and a send start
   * from. The caller owns the store and must close it.
   */
  private openSession(accountId: string): { path: string; store: SecretStore; auth: SecretStoreAuthState } {
    const path = sessionPath(this.context.secretsDir, accountId);
    if (!existsSync(path))
      throw new Error(
        fmt(_('no WhatsApp session for {account} — {hint}'), { account: accountId, hint: relinkHint() }),
      );
    const store = SecretStore.open(path);
    const auth = SecretStoreAuthState.open(store, { flushDelayMs: this.options.flushDelayMs });
    if (!auth.registered) {
      // `open` marked the fresh creds of an unlinked file dirty and armed its write-behind
      // timer: nothing of it may reach the file, and the timer must not outlive the store.
      auth.discard();
      store.close();
      throw new Error(
        fmt(_('the WhatsApp session {account} was never linked — {hint}'), {
          account: accountId,
          hint: relinkHint(),
        }),
      );
    }
    return { path, store, auth };
  }

  /**
   * A handle that may send ONE account's messages to the addresses the permit names (ADR 0004).
   *
   * It gets its own connection, and that connection is also handed WhatsApp's offline queue — so
   * it opens the SAME write-ahead journal the receive path uses and appends everything it is
   * given (`send.ts`). The journal is closed WITHOUT a release: a journalled event is dropped
   * only once the index has it, which the next sync's `nextBatch()` does.
   *
   * WhatsApp allows ONE connection per linked device, and the auth state is the same 0600 file
   * the receive loop writes with no lock between them. So the app serialises a send against the
   * daemon through the receive lease, which the manifest asks for with `sendSharesReceiveState`;
   * without it, a second socket on the same device credentials can get the daemon's connection
   * replaced (status 440) or, worse, leave the stored ratchet state behind what the server saw.
   * This is therefore the path for when NO other process holds the device; while the daemon does,
   * the send runs on its connection instead — `inSessionSender` above.
   *
   * Unlike Signal's sender, this one FLUSHES the auth state on close instead of discarding it:
   * Baileys writes the libsignal sessions of the recipient's devices through the same key store,
   * the whole fan-out leaves in one stanza, and a session the recipient has already ratcheted
   * forward must not be rolled back here — the next message would be undecryptable for them.
   */
  async openSender(accountId: string, permit: SendPermit): Promise<MessageSender> {
    parseSettings(this.context.settings);
    const { path, store, auth } = this.openSession(accountId);
    const mapper = new WhatsAppMapper(new JidResolver(auth.lidLookup()));
    const closeFiles = () => {
      try {
        auth.flush();
      } finally {
        store.close();
      }
    };
    let journal: FileJournal;
    try {
      journal = FileJournal.open(journalPath(path));
    } catch (err) {
      closeFiles();
      throw err;
    }
    const createSocket = this.options.createSendSocket ?? createBaileysSendSocket;
    let socket: WaSendSocketHandle;
    try {
      socket = createSocket({ auth });
    } catch (err) {
      journal.close();
      closeFiles();
      throw err;
    }
    return new WhatsAppSender(
      {
        socket: guardedSendSocket(socket, permit.addresses),
        mapper,
        journal,
        ...(this.options.sendAckMs === undefined ? {} : { ackMs: this.options.sendAckMs }),
        onClose: () => {
          try {
            journal.close();
          } finally {
            closeFiles();
          }
        },
      },
      permit,
    );
  }

  /**
   * Send on the connection a `connect()` session is already running on — what `curlew daemon`
   * serves over the session bus (ADR 0004, amendment 2026-10-30, daemon send).
   *
   * WhatsApp allows ONE connection per linked device, so this is the only way a send can happen
   * while the daemon has the device: not a second socket, a second VIEW of the daemon's
   * (`WaConnection.openSend`). What makes it the same send as the direct path rather than a hole
   * in it:
   *
   *   - the receive path still cannot write. It is handed `connection.handle`, a `WaSocketHandle`
   *     with no send method, and the send view is built here and handed straight to
   *     `guardedSendSocket` — so the per-permit fence sits between the sender and Baileys exactly
   *     as it does for a socket of its own;
   *   - `WhatsAppSender` re-checks the permit itself, as there;
   *   - the auth state is the daemon's own: one process, one write-behind, no two writers on the
   *     0600 session file — which is what made a second socket unsafe in the first place.
   *
   * `journal: null` because the daemon's receive loop is journalling this connection already, and
   * the mapper is that loop's: a second `subscribeMapped` would map and journal every incoming
   * message twice. `onClose` releases nothing — the connection, the journal and the session file
   * belong to the receiver and outlive every sender.
   */
  private async inSessionSender(
    live: () => WaConnection | null,
    mapper: WhatsAppMapper,
    permit: SendPermit,
  ): Promise<MessageSender> {
    const connection = live();
    if (!connection) {
      throw new Error(
        fmt(_('the WhatsApp connection for {account} is not open — nothing was sent'), {
          account: permit.account,
        }),
      );
    }
    return new WhatsAppSender(
      {
        socket: guardedSendSocket(connection.openSend(), permit.addresses),
        mapper,
        journal: null,
        ...(this.options.sendAckMs === undefined ? {} : { ackMs: this.options.sendAckMs }),
        onClose: () => {},
      },
      permit,
    );
  }

  async connect(accountId: string, options: DeliveryConnectOptions): Promise<DeliverySession> {
    parseSettings(this.context.settings);
    const { path, store, auth } = this.openSession(accountId);
    // One of the two, never both: a `createSocket` override means receive-only (see the option).
    const createConnection = this.options.createSocket
      ? null
      : (this.options.createConnection ?? createBaileysConnection);
    const createSocket = this.options.createSocket;
    const mapper = new WhatsAppMapper(new JidResolver(auth.lidLookup()));
    let journal: FileJournal;
    try {
      journal = FileJournal.open(journalPath(path));
    } catch (err) {
      auth.flush();
      store.close();
      throw err;
    }
    /**
     * The connection the receiver is on RIGHT NOW. The receiver reconnects by asking for a fresh
     * one, so a send view may only ever be opened off this — not off the connection the session
     * started with, which a reconnect has already closed.
     */
    let live: WaConnection | null = null;
    const openSocket = () => {
      if (createSocket) return createSocket({ auth });
      const connection = createConnection!({ auth });
      live = connection;
      // Only ever the receive view: the receiver is handed a `WaSocketHandle` and can do nothing
      // else with it, exactly as before this connection learned to send.
      return connection.handle;
    };
    const receiver = new WhatsAppReceiver(openSocket, mapper, {
      ...this.options.receiver,
      mode: options.mode,
      journal,
      initialSync: !(auth.state.creds.accountSyncCounter > 0),
    });
    receiver.start();
    return {
      nextBatch: () => receiver.nextBatch(),
      outcome: () => receiver.outcome(),
      ...(createConnection === null
        ? {}
        : { openSender: (permit: SendPermit) => this.inSessionSender(() => live, mapper, permit) }),
      close: async () => {
        try {
          await receiver.close();
        } finally {
          // The ratchet steps of this run go to disk before the file is let go.
          try {
            auth.flush();
          } finally {
            store.close();
          }
        }
      },
    };
  }
}
