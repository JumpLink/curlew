/**
 * What the frontends may ask about OMEMO (ADR 0006 §6/§7).
 *
 * Everything here works on the account's secret file and nothing connects or publishes. The two
 * readers — which accounts the grants let curlew decrypt, which device keys a file holds — are
 * open to every frontend. The two WRITERS, a trust decision and a session reset, exist only
 * because the CLI calls them after a person retyped a fingerprint at a terminal; no grant covers
 * them and the MCP server registers neither, because an agent reads message text written by
 * others and a message that talked it into verifying a key would hand over the conversation.
 *
 * The device listing reads the account's secret file directly rather than asking the server,
 * which is why it works offline and why it shows keys curlew has actually talked to instead of
 * whatever a stranger has published.
 */

import { fingerprint, formatFingerprint, parseFingerprint } from '@curlew/omemo';
import { configPath, SecretStore } from '@curlew/store';
import {
  accountPath,
  type DeviceSummary,
  loadOwnDevice,
  MESSAGES,
  type ResetResult,
  SecretStoreOmemoStorage,
  setTrustByFingerprint,
  resetSessions,
  summarizeDevices,
  type TrustDecision,
} from '@curlew/xmpp';
import { existsSync } from 'node:fs';
import { backendContext } from '../backends/context.ts';
import { loadConfig, type CurlewConfig } from '../config.ts';
import type { Grant } from '../grants.ts';
import { _, fmt } from '@curlew/protocol';

export const OMEMO_CAPABILITY = 'xmpp.omemo';

/**
 * The accounts whose connection may decrypt — `ChatSyncOptions.decryptAccounts`.
 *
 * The grant names the account alone, so this is the whole check: no address to match, nothing
 * to parse. An account missing from the list syncs as it always did, with its encrypted
 * messages indexed without text.
 */
export function decryptAccounts(grants: readonly Grant[] | undefined): string[] {
  return [...new Set((grants ?? []).filter((g) => g.capability === OMEMO_CAPABILITY).map((g) => g.target))];
}

export interface OmemoDevicesParams {
  /** The xmpp account to look in. */
  accountId: string;
  /** Only this contact's devices; every known JID when absent. */
  jid?: string;
  configPath?: string;
}

export interface OmemoAccountDevices {
  accountId: string;
  /** The device curlew publishes for this account, or null when it has never been one. */
  own: { deviceId: number; fingerprint: string; formatted: string } | null;
  /** Every device this account holds a key for, own device included, by JID then id. */
  devices: DeviceSummary[];
}

/**
 * Open one account's OMEMO storage, run `body`, close it again.
 *
 * The store is a file lock as much as a database (ADR 0006 §4), so it is held for exactly the
 * length of the call and never cached — the daemon wants the same file.
 */
async function withStorage<T>(
  params: { accountId: string; configPath?: string },
  body: (storage: SecretStoreOmemoStorage) => Promise<T>,
): Promise<T> {
  const config = loadConfig(params.configPath ?? configPath());
  const path = accountPath(backendContext('xmpp', config).secretsDir, params.accountId);
  if (!existsSync(path)) {
    throw new Error(
      fmt(_('no xmpp account {account} — `curlew accounts list` shows them'), { account: params.accountId }),
    );
  }
  const store = SecretStore.open(path);
  try {
    return await body(new SecretStoreOmemoStorage(store));
  } finally {
    store.close();
  }
}

/** The device keys stored for one account. Reads; never connects. */
export async function omemoDevices(params: OmemoDevicesParams): Promise<OmemoAccountDevices> {
  return withStorage(params, async (storage) => {
    const device = await loadOwnDevice(storage);
    const jids = params.jid === undefined ? await storage.listIdentityJids() : [params.jid];
    const devices: DeviceSummary[] = [];
    for (const jid of jids) devices.push(...(await summarizeDevices(storage, jid, device?.deviceId)));
    return {
      accountId: params.accountId,
      own:
        device === undefined
          ? null
          : {
              deviceId: device.deviceId,
              ...ownPrint(device.identityKey.publicKey),
            },
      devices,
    };
  });
}

function ownPrint(publicKey: Uint8Array): { fingerprint: string; formatted: string } {
  return { fingerprint: fingerprint(publicKey), formatted: formatFingerprint(publicKey) };
}

/**
 * Check the fingerprint a person typed back against the one being decided, and hand it on (§6).
 *
 * The comparison is on the PARSED key, so grouping, case and separators do not matter: someone
 * reading 64 hex characters off another phone must not fail on a space. What has to match is the
 * key — and a typo in the key is the entire reason for asking twice.
 *
 * Lives here rather than in the CLI so the sentences stay with the other OMEMO sentences, and so
 * a second frontend that grows a terminal cannot re-implement the check more loosely.
 */
export function requireRetypedFingerprint(expected: string, typed: string): string {
  const wanted = parseFingerprint(expected);
  if (wanted === undefined) throw new Error(MESSAGES.omemoTrust.unparsable);
  const got = parseFingerprint(typed);
  if (got === undefined || fingerprint(got) !== fingerprint(wanted)) {
    throw new Error(MESSAGES.omemoTrust.mismatch);
  }
  return typed;
}

export interface OmemoTrustParams {
  /** The xmpp account whose file holds the key. */
  accountId: string;
  /** The contact the key belongs to — a trust decision is per key, but it is stored per JID. */
  jid: string;
  /** The fingerprint as the person retyped it: grouping, case and separators are ignored. */
  fingerprint: string;
  state: TrustDecision;
  configPath?: string;
}

export interface OmemoTrustOutcome {
  accountId: string;
  jid: string;
  deviceId: number;
  trust: TrustDecision;
  fingerprint: string;
  formatted: string;
  /** The decision adopted a key that had replaced the stored one; its ratchet went with it. */
  adopted: boolean;
  sessionDropped: boolean;
}

/**
 * Decide one device key (ADR 0006 §6). The CLI is the only caller, after a terminal check.
 *
 * The three ways a typed fingerprint can miss are errors, not results: nothing changed, and the
 * person needs to read why rather than find a JSON object that quietly says "no". They carry the
 * sentence from `MESSAGES.omemoTrust`, so every frontend says the same thing in the same
 * language.
 */
export async function omemoTrust(params: OmemoTrustParams): Promise<OmemoTrustOutcome> {
  return withStorage(params, async (storage) => {
    const result = await setTrustByFingerprint(storage, params.jid, params.fingerprint, params.state);
    switch (result.kind) {
      case 'unparsable':
        throw new Error(MESSAGES.omemoTrust.unparsable);
      case 'unknown':
        throw new Error(MESSAGES.omemoTrust.unknown(params.jid));
      case 'ambiguous':
        throw new Error(MESSAGES.omemoTrust.ambiguous(params.jid, result.count));
      case 'set':
        return {
          accountId: params.accountId,
          jid: result.address.jid,
          deviceId: result.address.deviceId,
          trust: result.trust,
          fingerprint: result.fingerprint,
          formatted: result.formatted,
          adopted: result.adopted,
          sessionDropped: result.sessionDropped,
        };
    }
  });
}

export interface OmemoResetParams {
  accountId: string;
  /** Every ratchet with this contact goes; their keys and your decisions about them stay. */
  jid: string;
  configPath?: string;
}

export interface OmemoResetOutcome extends ResetResult {
  accountId: string;
  jid: string;
}

/** Throw away the sessions with one contact so the next message rebuilds them (§6). */
export async function omemoReset(params: OmemoResetParams): Promise<OmemoResetOutcome> {
  return withStorage(params, async (storage) => ({
    accountId: params.accountId,
    jid: params.jid,
    ...(await resetSessions(storage, params.jid)),
  }));
}

/**
 * Does `config.encryption` forbid plain text to this peer (ADR 0006 §7)?
 *
 * Keyed like a grant target, and the account-wide key counts for every peer of that account —
 * the broader setting is the safer one, so it widens rather than needing to be repeated.
 */
export function encryptionRequired(
  config: Pick<CurlewConfig, 'encryption'>,
  accountId: string,
  to: string,
): boolean {
  return (
    config.encryption[`${accountId}/${to}`] === 'required' || config.encryption[accountId] === 'required'
  );
}

/** Which of an account's granted addresses are covered — `ChatConnectOptions.requireEncryption`. */
export function requireEncryptionFor(
  config: Pick<CurlewConfig, 'encryption'>,
  accountId: string,
  addresses: readonly string[],
): string[] {
  return addresses.filter((address) => encryptionRequired(config, accountId, address));
}
