/**
 * What the frontends may ask about OMEMO (ADR 0006 §6).
 *
 * Two things only, and both read: which accounts the grants let curlew decrypt, and which device
 * keys an account's file holds. Nothing here connects, publishes or changes a trust state —
 * verifying a key is a human's act, and the CLI command that does it is the only writer. An MCP
 * tool that could verify would let a crafted message hand over the conversation.
 *
 * The device listing reads the account's secret file directly rather than asking the server,
 * which is why it works offline and why it shows keys curlew has actually talked to instead of
 * whatever a stranger has published.
 */

import { fingerprint, formatFingerprint } from '@curlew/omemo';
import { configPath, SecretStore } from '@curlew/store';
import {
  accountPath,
  type DeviceSummary,
  loadOwnDevice,
  SecretStoreOmemoStorage,
  summarizeDevices,
} from '@curlew/xmpp';
import { existsSync } from 'node:fs';
import { backendContext } from '../backends/context.ts';
import { loadConfig } from '../config.ts';
import type { Grant } from '../grants.ts';

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

/** The device keys stored for one account. Reads; never connects. */
export async function omemoDevices(params: OmemoDevicesParams): Promise<OmemoAccountDevices> {
  const config = loadConfig(params.configPath ?? configPath());
  const path = accountPath(backendContext('xmpp', config).secretsDir, params.accountId);
  if (!existsSync(path)) {
    throw new Error(`no xmpp account ${params.accountId} — \`curlew accounts list\` shows them`);
  }
  const store = SecretStore.open(path);
  try {
    const storage = new SecretStoreOmemoStorage(store);
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
  } finally {
    store.close();
  }
}

function ownPrint(publicKey: Uint8Array): { fingerprint: string; formatted: string } {
  return { fingerprint: fingerprint(publicKey), formatted: formatFingerprint(publicKey) };
}
