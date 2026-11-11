/**
 * Where a mail account's servers and password come from: Curlew's own account files first, the
 * system's account store (GNOME Online Accounts) as the shortcut for accounts that already exist
 * there. Without one — a Flatpak, a desktop that has none — the second source is simply empty.
 *
 * A system account for an address Curlew also holds itself is left out, so the person sees it once.
 * The own one wins: it is the one they set up here, and it works the same in a sandbox.
 */

import type { MailTarget, SmtpTarget } from '@curlew/protocol';
import { secretsDir } from '@curlew/store';
import { join } from 'node:path';
import type { SystemAccounts } from '@gjsify/system-accounts';
import { ownMailTarget, ownSmtpTarget, readOwnAccounts } from './own-accounts.ts';
import { hostAccounts, systemMailTargets, systemSmtpTargets } from './system-targets.ts';

/** Where the own account files live: the same directory the registry hands the mail backend. */
export function mailSecretsDir(): string {
  return join(secretsDir(), 'mail');
}

/** The IMAP targets, own accounts first. `accountId` narrows to one. */
export async function resolveMailTargets(
  accountId?: string,
  dir = mailSecretsDir(),
  accounts: () => Promise<SystemAccounts> = hostAccounts,
): Promise<MailTarget[]> {
  const held = readOwnAccounts(dir);
  const own = [...held]
    .filter(([id]) => !accountId || id === accountId)
    .map(([id, account]) => ownMailTarget(dir, id, account));
  if (accountId && own.length > 0) return own;
  const addresses = new Set([...held.values()].map((a) => a.address));
  let system: MailTarget[];
  try {
    system = await systemMailTargets(await accounts(), accountId);
  } catch (err) {
    // Own accounts are enough to work with; a failing system store is only worth raising when it
    // is all there is to report.
    if (own.length > 0) return own;
    throw err;
  }
  return [...own, ...system.filter((t) => !addresses.has(t.user.toLowerCase()))];
}

/** The SMTP targets, own accounts first. `accountId` narrows to one. */
export async function resolveSmtpTargets(
  accountId?: string,
  dir = mailSecretsDir(),
  accounts: () => Promise<SystemAccounts> = hostAccounts,
): Promise<SmtpTarget[]> {
  const held = readOwnAccounts(dir);
  const own = [...held]
    .filter(([id]) => !accountId || id === accountId)
    .map(([id, account]) => ownSmtpTarget(dir, id, account));
  if (accountId && own.length > 0) return own;
  const addresses = new Set([...held.values()].map((a) => a.address));
  let system: SmtpTarget[];
  try {
    system = await systemSmtpTargets(await accounts(), accountId);
  } catch (err) {
    if (own.length > 0) return own;
    throw err;
  }
  return [...own, ...system.filter((t) => !addresses.has(t.from.toLowerCase()))];
}
