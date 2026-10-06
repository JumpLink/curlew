/**
 * Delivery actions — what the delivery-only backends (WhatsApp, Signal) received and postbote
 * could not turn into a message.
 *
 * One ledger exists today: Signal's. A plaintext it decrypted but could not map (a field a newer
 * Signal added, a parser bug) is kept raw in the account file, because Signal deletes an envelope
 * once this device acknowledged it — a `sync` run only COUNTS those (`DeliveryOutcome.setAside`).
 * This is how the user sees WHICH ones: the sender and the time find the message on the phone, the
 * reason and the size are what a decoder-bug report needs.
 *
 * The redaction is not this layer's promise, it is the port's: a `SetAsideRecord` carries no
 * plaintext to begin with, so nothing here can print one and no flag adds it. The plaintext stays
 * in the backend's secret file, where whoever holds the phone's own copy of that message is the
 * one who reads it.
 *
 * Deliberately no MCP tool: this is a human diagnostic. Putting message-derived data into an
 * agent's context buys nothing that a sender and a timestamp do not.
 */

import { isDeliveryBackend, type SetAsideRecord } from '@curlew/protocol';
import { configPath } from '@curlew/store';
import { builtinRegistry } from '../backends/builtin.ts';
import { backendContext } from '../backends/context.ts';
import { loadConfig } from '../config.ts';

/** One account's ledger, as this listing reports it. */
export interface SetAsideAccount {
  backend: string;
  accountId: string;
  /** Entries below — the same number, so a caller need not walk the array to count. */
  count: number;
  /** What this listing leaves out besides `entries`: the backend's own bound pushed them out, or
   * it has no sender and time to show for them — either way this command prints nothing for them. */
  dropped: number;
  entries: SetAsideRecord[];
}

export interface DeliveriesSetAsideResult {
  /** Every kept entry of every account listed. */
  count: number;
  /** Every account's dropped count, summed. */
  dropped: number;
  accounts: SetAsideAccount[];
}

export interface SetAsideParams {
  accountId?: string;
  configPath?: string;
}

/**
 * List what every ENABLED delivery backend kept because it could not map it.
 *
 * Read-only and offline: it reads the backends' own files, never a server, and never writes. A
 * backend that keeps no ledger answers an empty list — an absent `setAsideLedger` is a fact about
 * the backend, not a failure of this command — and so does an account id no enabled backend knows.
 */
export async function deliveriesSetAside(params: SetAsideParams = {}): Promise<DeliveriesSetAsideResult> {
  const config = loadConfig(params.configPath ?? configPath());
  const registry = builtinRegistry();
  const accounts: SetAsideAccount[] = [];
  for (const plugin of registry.enabled(config)) {
    const name = plugin.manifest.name;
    const backend = registry.create(config, name, backendContext(name, config));
    // Only a delivery backend can have received something it could not map: the mailbox and chat
    // drivers read what a server still holds, so nothing is lost by not understanding it yet.
    if (!isDeliveryBackend(backend)) continue;
    for (const account of await backend.listAccounts()) {
      if (params.accountId && account.id !== params.accountId) continue;
      const ledger = (await backend.setAsideLedger?.(account.id)) ?? { entries: [], dropped: 0 };
      accounts.push({
        backend: name,
        accountId: account.id,
        count: ledger.entries.length,
        dropped: ledger.dropped,
        entries: ledger.entries,
      });
    }
  }
  return {
    count: accounts.reduce((n, account) => n + account.count, 0),
    dropped: accounts.reduce((n, account) => n + account.dropped, 0),
    accounts,
  };
}
