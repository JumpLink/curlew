/**
 * Pure model for adding an account from the window: which protocols can be added and what has
 * to be accepted first. No GTK, no bus — both runtimes test this.
 *
 * Mail is not here: its accounts are GNOME Online Accounts, added in GNOME Settings, so the page
 * links there instead of running a login.
 */

import type { TermsNotice } from '@curlew/protocol';

import type { BackendStatus } from '../core/backends/registry.ts';
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

/** Whether the person is shown terms before anything runs. */
export function needsTerms(protocol: AddableProtocol): boolean {
  return protocol.terms !== null;
}
