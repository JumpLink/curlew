import { describe, expect, it } from '@gjsify/unit';
import type { BackendAccount, GnomeAccount } from '@curlew/protocol';

import {
  accountStatus,
  accountSubtitle,
  avatarText,
  buildProtocolGroups,
  type AccountsDaemonState,
  type AccountsLoadState,
} from '../../../src/window/accounts-model.ts';
import type { BackendStatus } from '../../../src/core/backends/registry.ts';

function backend(name: string, enabled = true): BackendStatus {
  return {
    name,
    displayName: name,
    enabled,
    syncModel: 'continuous',
    storeTier: 'derived',
    native: true,
    capabilities: { send: false, receive: false, readOnly: true, agentSend: false },
    terms: null,
    termsAccepted: true,
  } as unknown as BackendStatus;
}

function goaAccount(over: Partial<GnomeAccount> & { id: string }): GnomeAccount {
  return {
    provider: 'google',
    providerName: 'Google',
    identity: over.id,
    presentation: over.id,
    capabilities: { mail: true, calendar: false, contacts: false, files: false },
    auth: { oauth2: true, password: false },
    ...over,
  } as GnomeAccount;
}

function chatAccount(over: Partial<BackendAccount> & { id: string }): BackendAccount {
  return {
    identity: over.id,
    provider: 'dummy',
    ...over,
  } as BackendAccount;
}

function daemonState(present: boolean, accounts: AccountsDaemonState['accounts']): AccountsDaemonState {
  return { present, accounts };
}

export default async () => {
  describe('accounts model', () => {
    it('maps daemon states to shown statuses', () => {
      expect(accountStatus(false, 'connected', '2026-01-01T00:00:00Z')).toStrictEqual({
        status: 'daemon-not-running',
      });
      expect(accountStatus(true, 'connected', '2026-01-01T00:00:00Z')).toStrictEqual({
        status: 'connected',
        since: '2026-01-01T00:00:00Z',
      });
      expect(accountStatus(true, 'connecting', 't1')).toStrictEqual({ status: 'connecting', since: 't1' });
      expect(accountStatus(true, 'reconnecting', 't2')).toStrictEqual({ status: 'connecting', since: 't2' });
      expect(accountStatus(true, 'logged-out', 't3')).toStrictEqual({ status: 'offline', since: 't3' });
      expect(accountStatus(true, 'held-elsewhere', 't4')).toStrictEqual({ status: 'offline', since: 't4' });
      expect(accountStatus(true, 'stopped', 't5')).toStrictEqual({ status: 'offline', since: 't5' });
      expect(accountStatus(true, undefined, 't6')).toStrictEqual({ status: 'offline', since: 't6' });
    });

    it('groups GOA accounts under mail and chat accounts under their protocol', () => {
      const load: AccountsLoadState = {
        backends: [backend('mail'), backend('xmpp'), backend('signal')],
        goaAccounts: {
          accounts: [
            goaAccount({ id: 'goa-2', identity: 'beta@example.org' }),
            goaAccount({ id: 'goa-1', identity: 'alpha@example.org' }),
          ],
        },
        chatAccounts: [
          { backend: 'xmpp', accounts: [chatAccount({ id: 'xmpp-b' }), chatAccount({ id: 'xmpp-a' })] },
          { backend: 'signal', accounts: [chatAccount({ id: 'signal-1' })] },
        ],
        labels: new Map([['xmpp-b', 'Work XMPP']]),
      };
      const state = buildProtocolGroups(load, daemonState(true, new Map()));
      expect(state.daemonPresent).toBe(true);
      expect(state.groups.map((g) => g.backend)).toStrictEqual(['mail', 'xmpp', 'signal']);

      const mail = state.groups.find((g) => g.backend === 'mail')!;
      expect(mail.rows.map((r) => r.label)).toStrictEqual(['alpha@example.org', 'beta@example.org']);
      // The daemon does not hold mail accounts, so no state is invented for them.
      expect(mail.rows[0]!.status).toBeNull();

      const xmpp = state.groups.find((g) => g.backend === 'xmpp')!;
      expect(xmpp.rows.map((r) => r.label)).toStrictEqual(['Work XMPP', 'xmpp-a']);
    });

    it('hides chat backends that are disabled', () => {
      const load: AccountsLoadState = {
        backends: [backend('mail'), backend('xmpp', false)],
        goaAccounts: { accounts: [] },
        chatAccounts: [{ backend: 'xmpp', accounts: [chatAccount({ id: 'xmpp-1' })] }],
        labels: new Map(),
      };
      const state = buildProtocolGroups(load, daemonState(true, new Map()));
      expect(state.groups.map((g) => g.backend)).toStrictEqual(['mail']);
    });

    it('shows a per-group error when a source fails', () => {
      const load: AccountsLoadState = {
        backends: [backend('mail'), backend('xmpp')],
        goaAccounts: { accounts: [], error: 'GOA unreachable' },
        chatAccounts: [{ backend: 'xmpp', accounts: [], error: 'backend crashed' }],
        labels: new Map(),
      };
      const state = buildProtocolGroups(load, daemonState(true, new Map()));
      expect(state.groups.find((g) => g.backend === 'mail')!.error).toBe('GOA unreachable');
      expect(state.groups.find((g) => g.backend === 'xmpp')!.error).toBe('backend crashed');
    });

    it('labels GOA accounts by identity, presentation, then id', () => {
      const load: AccountsLoadState = {
        backends: [backend('mail')],
        goaAccounts: {
          accounts: [
            goaAccount({ id: 'a', identity: 'identity-a', presentation: 'Pres' }),
            goaAccount({ id: 'b', identity: '', presentation: 'Pres-b' }),
            goaAccount({ id: 'c', identity: '', presentation: '' }),
          ],
        },
        chatAccounts: [],
        labels: new Map(),
      };
      const state = buildProtocolGroups(load, daemonState(true, new Map()));
      const byId = new Map(state.groups[0]!.rows.map((r) => [r.id, r.label]));
      expect(byId.get('a')).toBe('identity-a');
      expect(byId.get('b')).toBe('Pres-b');
      expect(byId.get('c')).toBe('c');
    });

    it('matches daemon state to accounts by backend and id', () => {
      const load: AccountsLoadState = {
        backends: [backend('mail'), backend('xmpp')],
        goaAccounts: { accounts: [goaAccount({ id: 'goa-1' })] },
        chatAccounts: [{ backend: 'xmpp', accounts: [chatAccount({ id: 'xmpp-1' })] }],
        labels: new Map(),
      };
      const accounts = new Map([
        ['mail/goa-1', { backend: 'mail', accountId: 'goa-1', state: 'connected' as const, since: 't1' }],
        ['xmpp/xmpp-1', { backend: 'xmpp', accountId: 'xmpp-1', state: 'connecting' as const, since: 't2' }],
      ]);
      const state = buildProtocolGroups(load, daemonState(true, accounts));
      const mailRow = state.groups.find((g) => g.backend === 'mail')!.rows[0]!;
      const xmppRow = state.groups.find((g) => g.backend === 'xmpp')!.rows[0]!;
      expect(mailRow.status).toBe('connected');
      expect(mailRow.since).toBe('t1');
      expect(xmppRow.status).toBe('connecting');
      expect(xmppRow.since).toBe('t2');
    });

    it('reports daemon-not-running for chat accounts when the daemon is absent', () => {
      const load: AccountsLoadState = {
        backends: [backend('mail'), backend('xmpp')],
        goaAccounts: { accounts: [goaAccount({ id: 'goa-1' })] },
        chatAccounts: [{ backend: 'xmpp', accounts: [chatAccount({ id: 'xmpp-1' })] }],
        labels: new Map(),
      };
      const state = buildProtocolGroups(load, daemonState(false, new Map()));
      expect(state.daemonPresent).toBe(false);
      expect(state.groups[0]!.rows[0]!.status).toBeNull();
      expect(state.groups[1]!.rows[0]!.status).toBe('daemon-not-running');
    });

    it('lists only GOA accounts that carry mail, once each', () => {
      const load: AccountsLoadState = {
        backends: [backend('mail')],
        goaAccounts: {
          accounts: [
            goaAccount({
              id: 'imap',
              identity: 'a@example.org',
              providerName: 'IMAP and SMTP',
              capabilities: { mail: true, calendar: false, contacts: false, files: false },
            }),
            goaAccount({
              id: 'dav',
              identity: 'a@example.org',
              providerName: 'Nextcloud',
              capabilities: { mail: false, calendar: true, contacts: true, files: true },
            }),
          ],
        },
        chatAccounts: [],
        labels: new Map(),
      };
      const rows = buildProtocolGroups(load, daemonState(true, new Map())).groups[0]!.rows;
      expect(rows.map((r) => r.id)).toStrictEqual(['imap']);
      expect(rows[0]!.detail).toBe('IMAP and SMTP · Mail');
    });

    it('lists the accounts Curlew holds itself, and a GOA account of the same address once', () => {
      const load: AccountsLoadState = {
        backends: [backend('mail')],
        goaAccounts: {
          accounts: [
            goaAccount({ id: 'goa-same', identity: 'Ada@Example.org', providerName: 'IMAP and SMTP' }),
            goaAccount({ id: 'goa-other', identity: 'bob@example.org', providerName: 'IMAP and SMTP' }),
          ],
        },
        ownMailAccounts: [
          chatAccount({ id: 'mail-own', identity: 'ada@example.org' }),
          chatAccount({ id: 'mail-off', identity: 'zed@example.org', disabled: true }),
        ],
        chatAccounts: [],
        labels: new Map(),
      };
      const group = buildProtocolGroups(load, daemonState(true, new Map())).groups[0]!;
      expect(group.rows.map((r) => r.id)).toStrictEqual(['mail-own', 'goa-other', 'mail-off']);
      expect(group.rows.map((r) => r.isGoa === true)).toStrictEqual([false, true, false]);
      expect(group.rows[2]!.status).toBe('disabled');
      expect(group.rows[0]!.status).toBeNull();
      expect(group.isGoa).toBe(true);
    });

    it('marks Delta Chat mail accounts and shows a paused GOA account as paused', () => {
      const load: AccountsLoadState = {
        backends: [backend('mail')],
        goaAccounts: {
          accounts: [
            goaAccount({ id: 'goa-a', identity: 'ada@example.org', providerName: 'IMAP and SMTP' }),
            goaAccount({ id: 'goa-b', identity: 'bob@example.org', providerName: 'IMAP and SMTP' }),
          ],
        },
        ownMailAccounts: [chatAccount({ id: 'mail-own', identity: 'cleo@example.org' })],
        chatAccounts: [],
        labels: new Map(),
        deltaChatIds: new Set(['goa-a', 'mail-own']),
        pausedKeys: new Set(['mail/goa-b']),
      };
      const rows = buildProtocolGroups(load, daemonState(true, new Map())).groups[0]!.rows;
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get('goa-a')!.deltaChat).toBe(true);
      expect(byId.get('mail-own')!.deltaChat).toBe(true);
      expect(byId.get('goa-b')!.deltaChat).toBeUndefined();
      expect(byId.get('goa-b')!.status).toBe('disabled');
      expect(byId.get('goa-a')!.status).not.toBe('disabled');
    });

    it('does not link to GNOME Settings when only own mail accounts exist', () => {
      const load: AccountsLoadState = {
        backends: [backend('mail')],
        goaAccounts: { accounts: [] },
        ownMailAccounts: [chatAccount({ id: 'mail-own', identity: 'ada@example.org' })],
        chatAccounts: [],
        labels: new Map(),
      };
      const group = buildProtocolGroups(load, daemonState(true, new Map())).groups[0]!;
      expect(group.isGoa).toBe(false);
      expect(group.rows.length).toBe(1);
    });

    it('shows the address under a chat nickname only when they differ', () => {
      const load: AccountsLoadState = {
        backends: [backend('xmpp')],
        goaAccounts: { accounts: [] },
        chatAccounts: [
          {
            backend: 'xmpp',
            accounts: [
              chatAccount({ id: 'a', identity: 'a@example.org' }),
              chatAccount({ id: 'b', identity: 'b@example.org' }),
            ],
          },
        ],
        labels: new Map([['b', 'Work']]),
      };
      const rows = buildProtocolGroups(load, daemonState(true, new Map())).groups[1]!.rows;
      expect(rows.find((r) => r.id === 'a')!.detail).toBeUndefined();
      expect(rows.find((r) => r.id === 'b')!.detail).toBe('b@example.org');
    });

    it('keeps chat accounts out of the mail group', () => {
      const load: AccountsLoadState = {
        backends: [backend('mail'), backend('xmpp')],
        goaAccounts: { accounts: [] },
        chatAccounts: [{ backend: 'xmpp', accounts: [chatAccount({ id: 'xmpp-1' })] }],
        labels: new Map(),
      };
      const state = buildProtocolGroups(load, daemonState(true, new Map()));
      expect(state.groups.map((g) => g.backend)).toStrictEqual(['mail', 'xmpp']);
      expect(state.groups[0]!.rows.length).toBe(0);
    });
  });

  describe('avatarText', () => {
    it('drops syntax and notes in parentheses so they do not become initials', () => {
      expect(avatarText('Robin (Signal)')).toBe('Robin');
      expect(avatarText('@robin:example.org')).toBe('robin:example.org');
      expect(avatarText('+49 170 0000000')).toBe('49 170 0000000');
      expect(avatarText('Ada Lovelace')).toBe('Ada Lovelace');
      expect(avatarText('(…)')).toBe('(…)');
    });
  });

  describe('accountSubtitle', () => {
    it('joins the parts that exist with a middle dot', () => {
      expect(accountSubtitle(['Connected', null, 'robin@example.org'])).toBe('Connected · robin@example.org');
      expect(accountSubtitle([null, undefined, ''])).toBe('');
    });
  });
};
