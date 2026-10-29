/**
 * One account's OMEMO state, opened for the length of a connection (ADR 0006 §3/§8).
 *
 * The pieces exist separately — the storage adapter, the device upkeep, the archive pass — and
 * this is where they meet the account's secret file. It is the only place that knows all three,
 * which keeps the knowledge out of the backend and out of the session.
 *
 * Opening it PUBLISHES: a first run writes a device list entry and a bundle, and a later one
 * rotates the signed prekey or replaces spent prekeys. So it runs only for a caller that holds
 * `xmpp.omemo` for this account. The caller owns the store it passes and closes it; this does
 * not, because the same store may outlive the session that borrowed it.
 */

import type { OmemoStorage } from '@curlew/omemo';
import type { SecretStore } from '@curlew/store';
import { decryptEntries } from './omemo-archive.ts';
import type { UndecryptableReason } from './omemo-receive.ts';
import type { OmemoDeviceOptions, OwnDevice } from './omemo-device.ts';
import { announceDevice, type Announcement, type PepPort } from './omemo-publish.ts';
import { SecretStoreOmemoStorage } from './omemo-storage.ts';
import type { DecryptEntries } from './session.ts';
import type { ArchivedEntry } from './stanza.ts';

export interface OmemoSessionOptions extends OmemoDeviceOptions {
  /** Called for every entry that stayed closed, with why. For counting and logging only. */
  readonly onUndecryptable?: (entry: ArchivedEntry, reason: UndecryptableReason) => void;
}

/** What an opened account's OMEMO gives its caller. */
export interface OmemoSession {
  readonly storage: OmemoStorage;
  readonly device: OwnDevice;
  /** What opening it had to publish — nothing, on an ordinary run. */
  readonly announcement: Announcement;
  /** Ready to hand to {@link XmppChatSession}. */
  readonly decrypt: DecryptEntries;
}

/**
 * Bring this account's device up to date on the server and hand back the pass that decrypts an
 * archive page with it.
 */
export async function openOmemo(
  pep: PepPort,
  store: SecretStore,
  selfJid: string,
  options: OmemoSessionOptions = {},
): Promise<OmemoSession> {
  const storage = new SecretStoreOmemoStorage(store);
  const announcement = await announceDevice(pep, storage, selfJid, options);
  const device = announcement.device;
  return {
    storage,
    device,
    announcement,
    decrypt: (entries, journalOnly) =>
      decryptEntries(storage, device, selfJid, entries, {
        journalOnly,
        ...(options.profile === undefined ? {} : { profile: options.profile }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.random === undefined ? {} : { random: options.random }),
        ...(options.onUndecryptable === undefined ? {} : { onUndecryptable: options.onUndecryptable }),
      }),
  };
}
