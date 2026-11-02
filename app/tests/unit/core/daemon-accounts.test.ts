import { describe, expect, it } from '@gjsify/unit';

import type { DeliveryProgress } from '@curlew/store';
import { AccountTable, stateAfter } from '../../../src/core/lib/daemon-accounts.ts';
import {
  DAEMON_INTERFACE_XML,
  DAEMON_WIRE_VERSION,
  parseDaemonAccountsReply,
} from '../../../src/core/lib/daemon-bus.ts';

/**
 * The account list `GetAccounts` answers (ADR 0007 §3): a mapping from the progress events the
 * daemon already logs, and nothing that reads as content. All data is synthetic.
 */

const T0 = new Date('2026-11-01T10:00:00.000Z');
const T1 = new Date('2026-11-01T10:05:00.000Z');
const who = { backend: 'signal', accountId: 'acct-1' };

export default async () => {
  await describe('the daemon account list', async () => {
    await it('maps every progress event to a state', async () => {
      const cases: [DeliveryProgress, string | null][] = [
        [{ ...who, type: 'connected' }, 'connected'],
        [{ ...who, type: 'batch', batches: 1, added: 1, edited: 0, removed: 0 }, null],
        [{ ...who, type: 'reconnect', delayMs: 5000, attempt: 1, reason: null }, 'reconnecting'],
        [{ ...who, type: 'logged-out', error: null }, 'logged-out'],
        [{ ...who, type: 'lease-held', holder: '42' }, 'held-elsewhere'],
        [{ ...who, type: 'lease-waiting', holder: null }, 'held-elsewhere'],
        [{ ...who, type: 'lease-busy' }, 'stopped'],
        [{ ...who, type: 'lease-lost' }, 'connecting'],
        [{ ...who, type: 'lease-unrefreshable' }, 'connecting'],
        [{ ...who, type: 'stopped', reason: 'aborted' }, 'stopped'],
        [{ ...who, type: 'stopped', reason: 'logged-out' }, 'logged-out'],
      ];
      for (const [event, state] of cases) {
        expect(stateAfter(event)?.state ?? null).toBe(state);
      }
    });

    await it('reports a change only when the entry moved, and keeps `since` while the state holds', async () => {
      const table = new AccountTable();
      expect(table.seed('signal', 'acct-1', T0)).toBe(true);
      expect(table.seed('signal', 'acct-1', T1)).toBe(false);
      expect(table.apply({ ...who, type: 'connected' }, T1)).toBe(true);
      expect(table.apply({ ...who, type: 'connected' }, new Date(T1.getTime() + 1000))).toBe(false);
      expect(table.apply({ ...who, type: 'batch', batches: 1, added: 1, edited: 0, removed: 0 }, T1)).toBe(
        false,
      );
      const entry = table.reply().accounts[0];
      expect(entry.state).toBe('connected');
      expect(entry.since).toBe(T1.toISOString());
      expect(entry.retryInMs).toBe(undefined);
    });

    await it('carries the wait only while reconnecting', async () => {
      const table = new AccountTable();
      table.apply({ ...who, type: 'reconnect', delayMs: 10_000, attempt: 2, reason: null }, T0);
      expect(table.reply().accounts[0].retryInMs).toBe(10_000);
      table.apply({ ...who, type: 'connected' }, T1);
      expect(table.reply().accounts[0].retryInMs).toBe(undefined);
    });

    await it('puts no content on the bus', async () => {
      const table = new AccountTable();
      table.apply({ ...who, type: 'logged-out', error: 'Alice +491701234567 said hello' }, T0);
      table.apply({ backend: 'signal', accountId: 'acct-2', type: 'lease-held', holder: 'Bob-Laptop' }, T0);
      table.apply(
        {
          backend: 'signal',
          accountId: 'acct-3',
          type: 'reconnect',
          delayMs: 5000,
          attempt: 1,
          reason: 'Alice 491701234567',
        },
        T0,
      );
      const json = JSON.stringify(table.reply());
      for (const secret of ['Alice', '491701234567', 'hello', 'Bob-Laptop']) {
        expect(json.includes(secret)).toBe(false);
      }
      for (const entry of table.reply().accounts) {
        expect(
          Object.keys(entry).filter(
            (k) => !['backend', 'accountId', 'state', 'since', 'retryInMs'].includes(k),
          ).length,
        ).toBe(0);
      }
      expect(DAEMON_INTERFACE_XML.includes('<arg type="t" name="seq"/>')).toBe(true);
      expect(DAEMON_INTERFACE_XML.includes('type="s" name="text"')).toBe(false);
    });

    await it('reads a reply and refuses a foreign version', async () => {
      const table = new AccountTable();
      table.seed('signal', 'acct-1', T0);
      expect(parseDaemonAccountsReply(JSON.stringify(table.reply())).accounts.length).toBe(1);
      let message = '';
      try {
        parseDaemonAccountsReply(JSON.stringify({ v: DAEMON_WIRE_VERSION + 1, accounts: [] }));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message.length > 0).toBe(true);
    });
  });
};
