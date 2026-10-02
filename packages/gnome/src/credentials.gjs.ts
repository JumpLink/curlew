/**
 * Resolve GOA accounts into connectable IMAP targets, credentials included.
 *
 * Extracted from the old mail.gjs.ts so that everything touching `Goa` lives in this package:
 * the IMAP layer receives plain `MailTarget`s with a `getPassword()` thunk and never imports
 * the GOA typelib itself. Runs unchanged on GJS and on Node/Bun via `@gjsify/node-gi`.
 *
 * Privacy: the password is read from GOA per connection and is never cached here, never
 * logged, and never part of a returned DTO.
 */

import type Goa from 'gi://Goa?version=1.0';

import { GnomeError, type MailTarget } from '@postbote/protocol';
import { gnomeError, isGnomeFailure } from './errors.ts';
import { getClient } from './goa.gjs.ts';

/** Read the IMAP password from GOA. Tries the standard id, then compat fallbacks. */
function getPassword(obj: Goa.Object): string {
  const pb = obj.get_password_based();
  if (!pb) throw new GnomeError('account has no password-based credentials');
  for (const id of ['imap-password', 'password', '']) {
    try {
      const [ok, password] = pb.call_get_password_sync(id, null);
      if (ok && password) return password;
    } catch {
      // try the next id
    }
  }
  throw new GnomeError('could not retrieve IMAP password from GOA');
}

/** Do the work. Everything here may raise a native error; `listMailTargets` owns the boundary. */
async function listMailTargetsImpl(accountId?: string): Promise<MailTarget[]> {
  // `getClient` is the GOA error boundary — already a GnomeError or GnomeUnavailableError.
  const client = await getClient();
  const targets: MailTarget[] = [];
  for (const obj of client.get_accounts()) {
    const mail = obj.get_mail();
    if (!mail || !mail.imap_supported) continue;
    const account = obj.get_account();
    if (accountId && account?.id !== accountId) continue;
    const rawHost = mail.imap_host ?? '';
    if (!rawHost) continue;
    let host = rawHost;
    let port: number;
    if (rawHost.includes(':')) {
      const [h, p] = rawHost.split(':');
      host = h;
      port = Number.parseInt(p, 10);
    } else {
      port = mail.imap_use_ssl ? 993 : 143;
    }
    targets.push({
      accountId: account?.id ?? '',
      host,
      port,
      user: mail.imap_user_name ?? '',
      implicitTls: mail.imap_use_ssl || (!mail.imap_use_tls && port === 993),
      getPassword: () => getPassword(obj),
    });
  }
  return targets;
}

/**
 * Resolve GOA mail accounts (optionally one) into connectable IMAP targets.
 *
 * The boundary for this path: `client.get_accounts()`, `obj.get_mail()`, `mail.imap_supported`
 * and the rest are `gi://` property reads that each raise independently of `getClient`'s
 * errors. Only an existing `GnomeError` / `GnomeUnavailableError` passes through unchanged.
 */
export async function listMailTargets(accountId?: string): Promise<MailTarget[]> {
  try {
    return await listMailTargetsImpl(accountId);
  } catch (err) {
    if (isGnomeFailure(err)) throw err;
    throw gnomeError('listMailTargets', err);
  }
}
