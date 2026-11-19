/**
 * Which address is the account's own. Kept apart from `send.ts` so the read-only backend can
 * answer `isSelfAddress` without the SMTP stack behind it (ADR 0018).
 */

import { resolveSmtpTargets } from './targets.ts';

/**
 * Whether `to` is the account's own mail address (`from` of its SMTP target), compared
 * case-insensitively and as a whole: a sub-address, another domain or a display-name form is not it.
 */
export function isOwnMailAddress(from: string, to: string): boolean {
  const own = from.trim().toLowerCase();
  return own.includes('@') && to.trim().toLowerCase() === own;
}

/** The mail backend's `isSelfAddress`: the SMTP target knows the account's own address. */
export async function isOwnAddressOf(accountId: string, to: string): Promise<boolean> {
  const target = (await resolveSmtpTargets(accountId)).find((t) => t.accountId === accountId);
  return target !== undefined && isOwnMailAddress(target.from, to);
}
