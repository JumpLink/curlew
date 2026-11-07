/**
 * Pure model for the Accounts dialog: what protocol groups exist, which accounts belong to each,
 * and what state the daemon reports for them. No GTK, no bus — both runtimes test this.
 *
 * Mail accounts are always sourced from GNOME Online Accounts (`accountsList`), never from the
 * mail backend's IMAP targets, so a GOA account is listed once and only once.
 */

import type { BackendAccount, GnomeAccount } from '@curlew/protocol';
import { _ } from '@curlew/protocol';

import type { BackendStatus } from '../core/backends/registry.ts';
import type { DaemonAccountEntry, DaemonAccountState } from '../core/lib/daemon-bus.ts';
import { protocolIcon, protocolLabel } from './conversation-list-model.ts';

export type AccountStatus = 'connected' | 'connecting' | 'offline' | 'daemon-not-running';

export interface AccountRow {
  id: string;
  label: string;
  status: AccountStatus;
  /** ISO time the daemon entered this state, when it is known. */
  since?: string;
}

export interface ProtocolGroup {
  backend: string;
  label: string;
  icon: string;
  /** GOA-sourced mail group carries the GNOME Settings button description. */
  description?: string;
  rows: AccountRow[];
  loading: boolean;
  error?: string;
  isGoa: boolean;
}

export interface AccountsPageState {
  groups: ProtocolGroup[];
  daemonPresent: boolean;
}

export interface AccountsLoadState {
  backends: BackendStatus[];
  goaAccounts: { accounts: GnomeAccount[]; error?: string };
  chatAccounts: { backend: string; accounts: BackendAccount[]; error?: string }[];
  labels: ReadonlyMap<string, string>;
}

export interface AccountsDaemonState {
  present: boolean;
  accounts: ReadonlyMap<string, DaemonAccountEntry>;
}

const PROTOCOL_ORDER = ['mail', 'xmpp', 'signal', 'matrix', 'telegram', 'whatsapp'];

function groupSortKey(backend: string): number {
  const index = PROTOCOL_ORDER.indexOf(backend);
  return index === -1 ? PROTOCOL_ORDER.length : index;
}

function sortGroups(groups: ProtocolGroup[]): ProtocolGroup[] {
  return [...groups].sort((a, b) => groupSortKey(a.backend) - groupSortKey(b.backend));
}

function goaDescription(): string {
  return _('Mail, contacts and calendar accounts are managed in GNOME Settings → Online Accounts.');
}

function goaAccountLabel(account: GnomeAccount): string {
  return account.identity || account.presentation || account.id;
}

function chatAccountLabel(account: BackendAccount, labels: ReadonlyMap<string, string>): string {
  return labels.get(account.id) || account.identity || account.id;
}

function daemonKey(backend: string, accountId: string): string {
  return `${backend}/${accountId}`;
}

function lookupDaemon(
  daemon: AccountsDaemonState,
  backend: string,
  accountId: string,
): DaemonAccountEntry | undefined {
  if (!daemon.present) return undefined;
  return daemon.accounts.get(daemonKey(backend, accountId));
}

/** Map a daemon state to the status this dialog shows. */
export function accountStatus(
  daemonPresent: boolean,
  state?: DaemonAccountState,
  since?: string,
): { status: AccountStatus; since?: string } {
  if (!daemonPresent) return { status: 'daemon-not-running' };
  switch (state) {
    case 'connected':
      return { status: 'connected', since };
    case 'connecting':
    case 'reconnecting':
      return { status: 'connecting', since };
    default:
      return { status: 'offline', since };
  }
}

function makeRow(id: string, label: string, backend: string, daemon: AccountsDaemonState): AccountRow {
  const entry = lookupDaemon(daemon, backend, id);
  const { status, since } = accountStatus(daemon.present, entry?.state, entry?.since);
  return { id, label, status, since };
}

/** Groups to show while accounts are still loading. */
export function loadingGroups(backends: BackendStatus[]): ProtocolGroup[] {
  const groups: ProtocolGroup[] = [
    {
      backend: 'mail',
      label: protocolLabel('mail'),
      icon: protocolIcon('mail'),
      description: goaDescription(),
      rows: [],
      loading: true,
      isGoa: true,
    },
  ];
  for (const backend of backends) {
    if (backend.name === 'mail' || !backend.enabled) continue;
    groups.push({
      backend: backend.name,
      label: protocolLabel(backend.name),
      icon: protocolIcon(backend.name),
      rows: [],
      loading: true,
      isGoa: false,
    });
  }
  return sortGroups(groups);
}

/** Build the full page state from loaded accounts and live daemon state. */
export function buildProtocolGroups(load: AccountsLoadState, daemon: AccountsDaemonState): AccountsPageState {
  const groups: ProtocolGroup[] = [
    {
      backend: 'mail',
      label: protocolLabel('mail'),
      icon: protocolIcon('mail'),
      description: goaDescription(),
      rows: load.goaAccounts.accounts
        .map((account) => makeRow(account.id, goaAccountLabel(account), 'mail', daemon))
        .sort((a, b) => a.label.localeCompare(b.label)),
      loading: false,
      error: load.goaAccounts.error,
      isGoa: true,
    },
  ];

  const enabledChat = new Set(load.backends.filter((b) => b.enabled && b.name !== 'mail').map((b) => b.name));
  for (const result of load.chatAccounts) {
    if (!enabledChat.has(result.backend)) continue;
    groups.push({
      backend: result.backend,
      label: protocolLabel(result.backend),
      icon: protocolIcon(result.backend),
      rows: result.accounts
        .map((account) => makeRow(account.id, chatAccountLabel(account, load.labels), result.backend, daemon))
        .sort((a, b) => a.label.localeCompare(b.label)),
      loading: false,
      error: result.error,
      isGoa: false,
    });
  }

  return { groups: sortGroups(groups), daemonPresent: daemon.present };
}
