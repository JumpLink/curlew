/**
 * Pure model for adding an account from the window: which protocols can be added and what has
 * to be accepted first. No GTK, no bus — both runtimes test this.
 *
 * Mail is listed apart from the chats (`mailProtocol`): it asks for an address and a password
 * rather than linking a device, and GNOME Settings stays a shortcut next to it, never the only way.
 */

import type { TermsNotice } from '@curlew/protocol';
import { _, _n, fmt } from '@curlew/protocol';

import type { BackendStatus } from '../core/backends/registry.ts';
import { type CurlewConfig, setDeltaChatIn } from '../core/config.ts';
import { DELTA_CHAT } from '../core/visibility.ts';
import { protocolIcon, protocolLabel } from './conversation-list-model.ts';

export interface AddableProtocol {
  backend: string;
  label: string;
  icon: string;
  /** What the person must read and accept before this backend is enabled; null when nothing is pending. */
  terms: TermsNotice | null;
  enabled: boolean;
}

const ORDER = ['signal', 'whatsapp', 'telegram', 'matrix', 'xmpp'];

function orderOf(backend: string): number {
  const index = ORDER.indexOf(backend);
  return index === -1 ? ORDER.length : index;
}

/** Every chat protocol, in a fixed order, with the terms that still stand between it and a login. */
export function addableProtocols(backends: readonly BackendStatus[]): AddableProtocol[] {
  return backends
    .filter((b) => b.name !== 'mail')
    .map((b) => ({
      backend: b.name,
      label: protocolLabel(b.name),
      icon: protocolIcon(b.name),
      terms: b.terms !== null && !b.termsAccepted ? b.terms : null,
      enabled: b.enabled,
    }))
    .sort((a, b) => orderOf(a.backend) - orderOf(b.backend) || a.label.localeCompare(b.label));
}

/** Mail as something to add, or null when the mail backend is not installed. It has no terms. */
export function mailProtocol(backends: readonly BackendStatus[]): AddableProtocol | null {
  const mail = backends.find((b) => b.name === 'mail');
  if (!mail) return null;
  return {
    backend: 'mail',
    label: protocolLabel('mail'),
    icon: protocolIcon('mail'),
    terms: null,
    enabled: mail.enabled,
  };
}

/**
 * Every protocol that can be switched on or off: mail first (it is the one most people keep), then
 * the chats in their fixed order. `terms` is null once accepted, so only a first switch-on asks.
 */
export function switchableProtocols(backends: readonly BackendStatus[]): AddableProtocol[] {
  const mail = mailProtocol(backends);
  return mail ? [mail, ...addableProtocols(backends)] : addableProtocols(backends);
}

/** Whether the person is shown terms before anything runs. */
export function needsTerms(protocol: AddableProtocol): boolean {
  return protocol.terms !== null;
}

/**
 * The "Delta Chat" row of the Protocols page. Derived, not a backend (ADR 0001 §5): it is on when
 * at least one mail account is opted in, and it needs the mail backend to be on.
 */
export interface DeltaChatRow {
  backend: string;
  label: string;
  icon: string;
  enabled: boolean;
  /** Mail accounts opted in. */
  count: number;
  /** False while mail is off: the row is greyed and the subtitle says why. */
  available: boolean;
}

export function deltaChatRow(
  backends: readonly BackendStatus[],
  config: Pick<CurlewConfig, 'deltaChatAccounts'>,
): DeltaChatRow {
  const mailOn = backends.find((b) => b.name === 'mail')?.enabled === true;
  const count = config.deltaChatAccounts?.length ?? 0;
  return {
    backend: DELTA_CHAT,
    label: protocolLabel(DELTA_CHAT),
    icon: protocolIcon(DELTA_CHAT),
    enabled: mailOn && count > 0,
    count,
    available: mailOn,
  };
}

export function deltaChatSubtitle(row: DeltaChatRow): string {
  if (!row.available) return _('Needs Mail to be switched on');
  if (!row.enabled) return _('Email chats with people on Delta Chat, ArcaneChat or DeltaTouch');
  return fmt(_n('{count} account', '{count} accounts', row.count), { count: row.count });
}

/** Opt exactly the `chosen` mail accounts of `all` into Delta Chat; writes only that config field. */
export function applyDeltaChatAccounts(
  config: CurlewConfig,
  all: readonly string[],
  chosen: ReadonlySet<string>,
): void {
  for (const id of all) setDeltaChatIn(config, id, chosen.has(id));
}
