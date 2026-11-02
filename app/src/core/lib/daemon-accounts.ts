/**
 * What `GetAccounts` answers (ADR 0007 §3): one entry per account the daemon looks after, built
 * from the same progress events `daemon.ts` already logs a line for. This is the mapping from
 * event to state and nothing more — the events remain the only state machine.
 *
 * Ids, states and timings only. The privacy rule of the log (ADR 0002 §6) holds for the bus too:
 * a `DeliveryProgress` can carry an error message or a holder, and neither is copied here.
 */

import type { DeliveryProgress } from '@curlew/store';
import type { DaemonAccountEntry, DaemonAccountState, DaemonAccountsReply } from './daemon-bus.ts';
import { DAEMON_WIRE_VERSION } from './daemon-bus.ts';

/** The state an event leaves its account in, or `null` when the event does not move it. */
export function stateAfter(
  event: DeliveryProgress,
): { state: DaemonAccountState; retryInMs?: number } | null {
  switch (event.type) {
    case 'connected':
      return { state: 'connected' };
    case 'batch':
      return null;
    case 'reconnect':
      return { state: 'reconnecting', retryInMs: event.delayMs };
    case 'logged-out':
      return { state: 'logged-out' };
    case 'lease-held':
    case 'lease-waiting':
      return { state: 'held-elsewhere' };
    case 'lease-busy':
      return { state: 'stopped' };
    // The lease went, the account takes it again through the wait-for-lease path.
    case 'lease-lost':
    case 'lease-unrefreshable':
      return { state: 'connecting' };
    case 'stopped':
      return { state: event.reason === 'logged-out' ? 'logged-out' : 'stopped' };
  }
}

export class AccountTable {
  private readonly entries = new Map<string, DaemonAccountEntry>();

  /** An account the daemon is about to connect; does not overwrite one already known. */
  seed(backend: string, accountId: string, now: Date): boolean {
    const key = `${backend}/${accountId}`;
    if (this.entries.has(key)) return false;
    this.entries.set(key, { backend, accountId, state: 'connecting', since: now.toISOString() });
    return true;
  }

  /** Apply one event. Returns whether the entry changed — then `AccountsChanged` is due. */
  apply(event: DeliveryProgress, now: Date): boolean {
    const next = stateAfter(event);
    if (next === null) return false;
    const key = `${event.backend}/${event.accountId}`;
    const before = this.entries.get(key);
    if (before !== undefined && before.state === next.state && before.retryInMs === next.retryInMs) {
      return false;
    }
    const entry: DaemonAccountEntry = {
      backend: event.backend,
      accountId: event.accountId,
      state: next.state,
      since: before !== undefined && before.state === next.state ? before.since : now.toISOString(),
      ...(next.retryInMs === undefined ? {} : { retryInMs: next.retryInMs }),
    };
    this.entries.set(key, entry);
    return true;
  }

  reply(): DaemonAccountsReply {
    return { v: DAEMON_WIRE_VERSION, accounts: [...this.entries.values()] };
  }
}
