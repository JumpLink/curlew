/**
 * The Signal backend — a `delivery` driver behind the same port as every other backend, loaded
 * only through the registry, and only after its terms notice was accepted.
 *
 * libsignal is loaded on first use (`lib.ts`): constructing the backend, listing its accounts and
 * reading its manifest touch no native code, so curlew starts on a platform without the addon.
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
  SetAsideLedger,
} from '@curlew/protocol';
import { SecretStore } from '@curlew/store';
import { existsSync } from 'node:fs';
import { listSessionAccounts, sessionPath } from './accounts.ts';
import { SIGNAL_TRUST_ROOTS_BASE64 } from './constants.ts';
import { type AttachmentDownloader, httpsDownloader } from './contacts.ts';
import { EnvelopeDecryptor } from './decrypt.ts';
import type { ChatFetch } from './guard.ts';
import { FileJournal, journalPath } from './journal.ts';
import { type SignalLib, loadSignalLib } from './lib.ts';
import { type LinkNetwork, linkSignal } from './link.ts';
import { SIGNAL_MANIFEST } from './manifest.ts';
import { SignalMapper } from './map.ts';
import { authenticatedChannel, createNet, isDelinked, linkChannel, liveConnector, sendChannel } from './net.ts';
import { fromBase64, type DeviceAccount, readSetAside, SignalProtocolStore } from './protocol-store.ts';
import { openProvisioning } from './provisioning.ts';
import { type ChatConnector, type ReceiverOptions, relinkHint, SignalReceiver } from './receiver.ts';
import { normalizeServiceId } from './schema.ts';
import { SignalSender } from './send.ts';

/** The non-secret settings this backend reads from `backends.signal.settings`. */
export interface SignalSettings {
  /** The name the phone lists this device under. */
  deviceName: string;
}

export function parseSettings(settings: BackendContext['settings']): SignalSettings {
  const unknown = Object.keys(settings).filter((k) => k !== 'deviceName');
  if (unknown.length > 0) {
    throw new Error(
      `unknown setting(s) for signal: ${unknown.join(', ')} — the only one is deviceName; the keys live in the 0600 session file, never in the config`,
    );
  }
  const name = settings.deviceName;
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 50)) {
    throw new Error('backends.signal.settings.deviceName must be a name of 1–50 characters');
  }
  return { deviceName: typeof name === 'string' ? name.trim() : 'curlew' };
}

export interface SignalBackendOptions {
  /** libsignal, for a test that has it loaded already. */
  lib?: SignalLib;
  /** The receive connection — a test hands in a scripted one. */
  connector?: (account: DeviceAccount) => ChatConnector;
  /** The link's network — a test plays the phone. */
  linkNetwork?: (lib: SignalLib) => LinkNetwork;
  /**
   * The connection ONE granted send uses — a test plays the server. Whatever provides it puts the
   * `sendFetch` gate on it, the same way the link's `channel()` carries `guardedFetch('link', …)`.
   */
  sendChannel?: (
    account: DeviceAccount,
    recipients: readonly string[],
  ) => Promise<{ fetch: ChatFetch; close(): Promise<void> }>;
  /** The contact-sync download. */
  download?: AttachmentDownloader;
  /** Sealed-sender trust roots (serialized public keys); Signal's production roots by default. */
  trustRoots?: readonly Uint8Array[];
  receiver?: Omit<ReceiverOptions, 'mode' | 'journal' | 'download'>;
}

export class SignalBackend implements DeliveryBackend, SendBackend {
  readonly manifest = SIGNAL_MANIFEST;
  readonly kind = 'delivery' as const;
  private readonly context: BackendContext;
  private readonly options: SignalBackendOptions;

  constructor(context: BackendContext, options: SignalBackendOptions = {}) {
    this.context = context;
    this.options = options;
  }

  private lib(): Promise<SignalLib> {
    return this.options.lib ? Promise.resolve(this.options.lib) : loadSignalLib();
  }

  async listAccounts(): Promise<BackendAccount[]> {
    return listSessionAccounts(this.context.secretsDir);
  }

  /**
   * The plaintexts this build could not map, read back from the account file: sender, time, why
   * and size, never the message. That is what finds them on the phone and what a decoder bug
   * report needs.
   *
   * A missing or empty session file is an empty ledger, not a failure — the file is opened, never
   * created, so asking about an account that was never linked changes nothing on disk. And no
   * libsignal: this must answer where the native addon does not load.
   */
  async setAsideLedger(accountId: string): Promise<SetAsideLedger> {
    const path = sessionPath(this.context.secretsDir, accountId);
    if (!existsSync(path)) return { entries: [], dropped: 0 };
    const file = SecretStore.open(path);
    try {
      return readSetAside(file);
    } finally {
      file.close();
    }
  }

  /** Link curlew as a device: a QR code to scan with the phone. */
  async addAccount(prompter: AccountPrompter): Promise<BackendAccount> {
    const settings = parseSettings(this.context.settings);
    const lib = await this.lib();
    const network =
      this.options.linkNetwork?.(lib) ??
      (() => {
        const net = createNet(lib);
        return {
          provisioning: (key, listener) => openProvisioning(lib, net, key, listener),
          channel: () => linkChannel(net),
          authenticatedChannel: (username: string, password: string) =>
            authenticatedChannel(net, username, password),
        } satisfies LinkNetwork;
      })();
    return linkSignal(lib, this.context, prompter, network, { deviceName: settings.deviceName });
  }

  /**
   * Open the account's session file and its linked device — what both a sync and a send start
   * from. The caller owns `file` and must close it.
   */
  private async openSession(
    accountId: string,
    lib: SignalLib,
  ): Promise<{ path: string; file: SecretStore; store: SignalProtocolStore; account: DeviceAccount }> {
    const path = sessionPath(this.context.secretsDir, accountId);
    if (!existsSync(path)) throw new Error(fmt(_('no Signal session for {account} — {hint}'), { account: accountId, hint: relinkHint() }));
    const file = SecretStore.open(path);
    const store = SignalProtocolStore.open(lib, file);
    const account = store.account();
    if (!account) {
      file.close();
      throw new Error(
        fmt(_('the Signal session {account} was never linked — {hint}'), { account: accountId, hint: relinkHint() }),
      );
    }
    return { path, file, store, account };
  }

  /**
   * A handle that may send ONE account's messages to the addresses the permit names (ADR 0004).
   *
   * It gets its own chat connection and its own gate: the permitted service ids are the permit's
   * addresses plus this account's own ACI, which is where the `SyncMessage.Sent` transcript goes —
   * nothing else is reachable from here, whatever the grants say elsewhere.
   *
   * The ratchet state is the same file the receive path writes, and nothing in it locks: the
   * caller serialises a send against the daemon through the receive lease, which the manifest asks
   * for with `sendSharesReceiveState`.
   */
  async openSender(accountId: string, permit: SendPermit): Promise<MessageSender> {
    parseSettings(this.context.settings);
    const lib = await this.lib();
    const { file, store, account } = await this.openSession(accountId, lib);
    const recipients: string[] = [
      ...permit.addresses.map((address) => normalizeServiceId(address) ?? address),
      account.aci,
    ];
    let channel: { fetch: ChatFetch; close(): Promise<void> };
    try {
      channel = await (this.options.sendChannel ?? ((a, r) => sendChannel(createNet(lib), a, r)))(
        account,
        recipients,
      );
    } catch (err) {
      file.close();
      throw err;
    }
    return new SignalSender(
      {
        lib,
        store,
        account,
        fetch: channel.fetch,
        onClose: async () => {
          try {
            await channel.close();
          } finally {
            // Only a send the server accepted flushed its ratchet state (see `deliver`); whatever
            // is still dirty belongs to a message that did not go out, and keeping it would leave
            // the session ahead of where the recipient believes it is.
            store.discard();
            file.close();
          }
        },
      },
      permit,
    );
  }

  async connect(accountId: string, options: DeliveryConnectOptions): Promise<DeliverySession> {
    parseSettings(this.context.settings);
    const lib = await this.lib();
    const { path, file, store, account } = await this.openSession(accountId, lib);
    let journal: FileJournal;
    try {
      journal = FileJournal.open(journalPath(path));
    } catch (err) {
      file.close();
      throw err;
    }
    const decryptor = new EnvelopeDecryptor(lib, store, {
      trustRoots: this.options.trustRoots ?? SIGNAL_TRUST_ROOTS_BASE64.map(fromBase64),
    });
    const mapper = new SignalMapper(
      account.aci,
      (masterKey) =>
        lib.zk.GroupSecretParams.deriveFromMasterKey(
        new lib.zk.GroupMasterKey(masterKey as Uint8Array<ArrayBuffer>),
      )
        .getPublicParams()
        .getGroupIdentifier()
        .serialize(),
      // Null on a session linked before the number was kept; the mapper then cannot recognise
      // our own number in a sent transcript, which is why it is stored at link time.
      store.pni(),
    );
    const connector = this.options.connector?.(account) ?? liveConnector(createNet(lib), account);
    const receiver = new SignalReceiver(connector, decryptor, mapper, store, {
      isDelinked: (err) => isDelinked(lib, err),
      ...this.options.receiver,
      mode: options.mode,
      journal,
      download: this.options.download ?? httpsDownloader(),
    });
    await receiver.start();
    return {
      nextBatch: () => receiver.nextBatch(),
      outcome: () => receiver.outcome(),
      close: async () => {
        try {
          await receiver.close();
        } finally {
          // Every commit flushed what it acknowledged. What is still dirty belongs to envelopes
          // that were NOT acknowledged: saving it would make their redelivery a "duplicate" and
          // lose them. So it is dropped, and the server delivers those envelopes again.
          store.discard();
          file.close();
        }
      },
    };
  }
}
