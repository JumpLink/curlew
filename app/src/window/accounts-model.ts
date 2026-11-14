/**
 * Pure model for the Accounts dialog: what protocol groups exist, which accounts belong to each,
 * and what state the daemon reports for them. No GTK, no bus — both runtimes test this.
 *
 * Mail has two sources: GNOME Online Accounts (`accountsList`) and the accounts Curlew holds itself
 * (ADR 0011). An address that is both is listed once, as the own account, because that is the one
 * Curlew can remove.
 */

import type { BackendAccount, GnomeAccount } from '@curlew/protocol';
import { _ } from '@curlew/protocol';

import { backendAvailable, currentPlatform } from '../core/platform.ts';
import type { BackendStatus } from '../core/backends/registry.ts';
import type { DaemonAccountEntry, DaemonAccountState } from '../core/lib/daemon-bus.ts';
import { protocolIcon, protocolLabel } from './conversation-list-model.ts';

/** `disabled`: the person switched the account off, so there is no state to follow. */
export type AccountStatus = 'connected' | 'connecting' | 'offline' | 'daemon-not-running' | 'disabled';

export interface AccountRow {
  id: string;
  label: string;
  /** Provider and what the account covers, for mail; the address behind a nickname, for chats. */
  detail?: string;
  /** Null when no live state applies: mail accounts are not held by the daemon. */
  status: AccountStatus | null;
  /** ISO time the daemon entered this state, when it is known. */
  since?: string;
  /** A GNOME Online Account: GNOME Settings owns the login, Curlew's page holds only its own switches. */
  isGoa?: boolean;
  /** A mail account opted into Delta Chat, so the list can say where it is active. */
  deltaChat?: boolean;
}

/** The row's second line: the parts that exist, in order, with a middle dot between. */
export function accountSubtitle(parts: ReadonlyArray<string | null | undefined>): string {
  return parts.filter((part): part is string => !!part).join(' · ');
}

/**
 * The text an account avatar takes its initials from. Adw.Avatar uses the first character of the
 * first two words, so syntax would become an initial: a leading "@" or "+", or a note in
 * parentheses ("Robin (Signal)" gave "R(").
 */
export function avatarText(label: string): string {
  const text = label
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter((word) => word !== '')
    .join(' ');
  return text || label;
}

export interface ProtocolGroup {
  backend: string;
  label: string;
  icon: string;
  rows: AccountRow[];
  error?: string;
  /** The group lists GNOME Online Accounts, so it links to GNOME Settings. */
  isGoa: boolean;
}

export interface AccountsPageState {
  groups: ProtocolGroup[];
  daemonPresent: boolean;
}

export interface AccountsLoadState {
  backends: BackendStatus[];
  goaAccounts: { accounts: GnomeAccount[]; error?: string };
  /** Mail accounts Curlew holds itself; absent when there are none. */
  ownMailAccounts?: BackendAccount[];
  chatAccounts: { backend: string; accounts: BackendAccount[]; error?: string }[];
  labels: ReadonlyMap<string, string>;
  /** Mail account ids opted into Delta Chat (`config.mailAccounts`). */
  deltaChatIds?: ReadonlySet<string>;
  /** Paused accounts as `<backend>/<accountId>` (`config.disabledAccounts`); GOA accounts have no flag of their own. */
  pausedKeys?: ReadonlySet<string>;
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

function goaAccountLabel(account: GnomeAccount): string {
  return account.identity || account.presentation || account.id;
}

/** "Google · Mail, Calendar": the provider and what the account covers in Curlew. */
function goaAccountDetail(account: GnomeAccount): string {
  const covers: string[] = [];
  if (account.capabilities.mail) covers.push(_('Mail'));
  if (account.capabilities.calendar) covers.push(_('Calendar'));
  if (account.capabilities.contacts) covers.push(_('Contacts'));
  return [account.providerName, covers.join(', ')].filter(Boolean).join(' · ');
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

function makeRow(
  id: string,
  label: string,
  backend: string,
  daemon: AccountsDaemonState,
  detail?: string,
  disabled = false,
  isGoa = false,
): AccountRow {
  const base = isGoa ? { id, label, detail, isGoa } : { id, label, detail };
  if (disabled) return { ...base, status: 'disabled' };
  const entry = lookupDaemon(daemon, backend, id);
  // The daemon holds live chat sessions only; a mail account has no state of its own to show.
  if (backend === 'mail' && !entry) return { ...base, status: null };
  const { status, since } = accountStatus(daemon.present, entry?.state, entry?.since);
  return { ...base, status, since };
}

/** The mail rows: own accounts, then GNOME Online Accounts whose address is not already an own one. */
function mailRows(load: AccountsLoadState, daemon: AccountsDaemonState): AccountRow[] {
  const own = load.ownMailAccounts ?? [];
  const ownAddresses = new Set(own.map((a) => a.identity.toLowerCase()));
  const goa = load.goaAccounts.accounts
    // A GOA account that only holds calendars or contacts has no mail to show here.
    .filter((account) => account.capabilities.mail)
    .filter((account) => !ownAddresses.has(account.identity.toLowerCase()))
    .map((account) =>
      makeRow(
        account.id,
        goaAccountLabel(account),
        'mail',
        daemon,
        goaAccountDetail(account),
        load.pausedKeys?.has(`mail/${account.id}`) === true,
        true,
      ),
    );
  const mine = own.map((account) =>
    makeRow(account.id, account.identity, 'mail', daemon, undefined, account.disabled === true),
  );
  return [...mine, ...goa]
    .map((row) => (load.deltaChatIds?.has(row.id) ? { ...row, deltaChat: true } : row))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Build the full page state from loaded accounts and live daemon state. */
export function buildProtocolGroups(
  load: AccountsLoadState,
  daemon: AccountsDaemonState,
  platform = currentPlatform(),
): AccountsPageState {
  const groups: ProtocolGroup[] = [];
  if (backendAvailable('mail', platform))
    groups.push({
      backend: 'mail',
      label: protocolLabel('mail'),
      icon: protocolIcon('mail'),
      rows: mailRows(load, daemon),
      error: load.goaAccounts.error,
      isGoa: load.goaAccounts.accounts.some((account) => account.capabilities.mail),
    });

  const enabledChat = new Set(load.backends.filter((b) => b.enabled && b.name !== 'mail').map((b) => b.name));
  for (const result of load.chatAccounts) {
    if (!enabledChat.has(result.backend)) continue;
    groups.push({
      backend: result.backend,
      label: protocolLabel(result.backend),
      icon: protocolIcon(result.backend),
      rows: result.accounts
        .map((account) => {
          const label = chatAccountLabel(account, load.labels);
          // A nickname hides the address; show it underneath so two accounts stay tellable apart.
          const detail = account.identity && account.identity !== label ? account.identity : undefined;
          return makeRow(account.id, label, result.backend, daemon, detail, account.disabled === true);
        })
        .sort((a, b) => a.label.localeCompare(b.label)),
      error: result.error,
      isGoa: false,
    });
  }

  return { groups: sortGroups(groups), daemonPresent: daemon.present };
}
