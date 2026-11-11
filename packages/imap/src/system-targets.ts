/**
 * Mail accounts the user already set up on their system, as connectable targets.
 *
 * The question goes to `@gjsify/system-accounts` (gjsify ADR 0095), which answers from GNOME
 * Online Accounts where there are any and with an empty list where there are none — a Flatpak
 * without the GOA hole, a desktop without GNOME. Curlew never asks "is this GOA".
 *
 * Privacy: a target carries a password THUNK. The secret is asked for per connection and is
 * never cached, logged or put in an error here.
 */

import { GnomeError, type MailTarget, type SmtpTarget } from '@curlew/protocol';
import type { Account, CredentialPurpose, MailSettings, SystemAccounts, Unavailable } from '@gjsify/system-accounts';

// The package's own guard sits in the entry that carries the top-level await; the check is a
// property test, so it lives here instead.
const isUnavailable = (value: MailSettings | Unavailable): value is Unavailable => 'reason' in value;

let shared: Promise<SystemAccounts> | undefined;

/**
 * The host's account store. Loaded on first use: the `&optional` GI import inside the package
 * costs a top-level await, which only the code that really asks for accounts should pay.
 */
export function hostAccounts(): Promise<SystemAccounts> {
  shared ??= import('@gjsify/system-accounts').then((m) => m.createSystemAccounts());
  return shared;
}

/** The password for one login. OAuth2 accounts (Google, Microsoft) are not supported by mail yet. */
function passwordThunk(accounts: SystemAccounts, account: Account, purpose: CredentialPurpose): () => Promise<string> {
  return async () => {
    const credentials = await accounts.getCredentials(account, purpose);
    if (credentials.kind === 'password') return credentials.secret;
    if (credentials.kind === 'oauth2') {
      throw new GnomeError(`the ${purpose} login of this account uses OAuth2, which Curlew does not support yet`);
    }
    throw new GnomeError(`could not retrieve the ${purpose} password (${credentials.reason})`);
  };
}

async function mailAccounts(accounts: SystemAccounts, accountId?: string): Promise<Account[]> {
  const all = await accounts.listAccounts('mail');
  return accountId ? all.filter((a) => a.id === accountId) : all;
}

/** IMAP targets of the system's mail accounts (optionally one). Only TLS from the first byte is offered. */
export async function systemMailTargets(accounts: SystemAccounts, accountId?: string): Promise<MailTarget[]> {
  const targets: MailTarget[] = [];
  for (const account of await mailAccounts(accounts, accountId)) {
    const settings = await accounts.getMailSettings(account);
    if (isUnavailable(settings) || !settings.imap) continue;
    const { host, port, security, username } = settings.imap;
    targets.push({
      accountId: account.id,
      host,
      port,
      user: username ?? '',
      implicitTls: security === 'tls',
      getPassword: passwordThunk(accounts, account, 'imap'),
    });
  }
  return targets;
}

/** SMTP targets of the system's mail accounts (optionally one). Accounts without a login or a sender are left out. */
export async function systemSmtpTargets(accounts: SystemAccounts, accountId?: string): Promise<SmtpTarget[]> {
  const targets: SmtpTarget[] = [];
  for (const account of await mailAccounts(accounts, accountId)) {
    const settings = await accounts.getMailSettings(account);
    if (isUnavailable(settings) || !settings.smtp) continue;
    const { host, port, security, username } = settings.smtp;
    const user = username ?? '';
    const from = settings.sender.address || (user.includes('@') ? user : '');
    if (!user || !from) continue;
    targets.push({
      accountId: account.id,
      from,
      host,
      port,
      user,
      // A store that reports no transport security gets STARTTLS, never plain text: `none` is
      // for a test's loopback server, and the transport refuses it anywhere else.
      security: security === 'none' ? 'starttls' : security,
      getPassword: passwordThunk(accounts, account, 'smtp'),
    });
  }
  return targets;
}
