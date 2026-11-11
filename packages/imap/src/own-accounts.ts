/**
 * A mail account Curlew holds itself, for a person who has no GNOME Online Account for it — or
 * none at all, as in a Flatpak (ADR 0011). One `<account id>.db` per account in the backend's
 * secrets directory (`SecretStore`: 0600 in 0700, backup tier `secret`), holding the address, the
 * two servers and the password. An account exists exactly as long as its file does.
 *
 * Same rule as every other password Curlew keeps: it never leaves this file for the config, a
 * log, an error message, a DTO or MCP output. The targets below carry it as a thunk, read per
 * connection.
 */

import type { BackendAccount, MailTarget, SmtpTarget } from '@curlew/protocol';
import { _, fmt, normalizeAddress } from '@curlew/protocol';
import { SecretStore, removeSecretFiles, stableId } from '@curlew/store';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ACCOUNT_ID = /^mail-[0-9a-z]+$/;
const NAMESPACE = 'mail.account';

export interface OwnMailAccount {
  /** The address mail is sent from; also the account's identity. */
  address: string;
  imap: { host: string; port: number; user: string };
  smtp: { host: string; port: number; user: string; security: 'tls' | 'starttls' };
  password: string;
}

/** Whether an id was made by `ownAccountIdFor`, i.e. names an account Curlew holds itself. */
export function isOwnAccountId(id: string): boolean {
  return ACCOUNT_ID.test(id);
}

/** The account id for an address: stable, and without the address in a file name. */
export function ownAccountIdFor(address: string): string {
  return stableId('mail-', normalizeOwnAddress(address));
}

/** An address as typed by the person, or an error that says what is wrong with it. */
export function normalizeOwnAddress(raw: string): string {
  const address = normalizeAddress('email', raw);
  if (!address) throw new Error(_('not an email address — expected name@example.org'));
  return address;
}

export function ownAccountPath(secretsDir: string, accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) throw new Error(fmt(_('not a mail account id: {account}'), { account: accountId }));
  return join(secretsDir, `${accountId}.db`);
}

function checkPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(fmt(_('not a port: {port}'), { port: String(port) }));
  }
}

/** Write (or replace) one account and return its listing entry; nothing secret is in it. */
export function writeOwnAccount(secretsDir: string, account: OwnMailAccount): BackendAccount {
  const address = normalizeOwnAddress(account.address);
  checkPort(account.imap.port);
  checkPort(account.smtp.port);
  if (!account.imap.host.trim() || !account.smtp.host.trim()) throw new Error(_('a server name is missing'));
  if (!account.password) throw new Error(_('the password is empty'));
  const id = ownAccountIdFor(address);
  const store = SecretStore.open(ownAccountPath(secretsDir, id));
  try {
    store.apply([
      { namespace: NAMESPACE, key: 'address', value: address },
      { namespace: NAMESPACE, key: 'imapHost', value: account.imap.host.trim() },
      { namespace: NAMESPACE, key: 'imapPort', value: String(account.imap.port) },
      { namespace: NAMESPACE, key: 'imapUser', value: account.imap.user },
      { namespace: NAMESPACE, key: 'smtpHost', value: account.smtp.host.trim() },
      { namespace: NAMESPACE, key: 'smtpPort', value: String(account.smtp.port) },
      { namespace: NAMESPACE, key: 'smtpUser', value: account.smtp.user },
      { namespace: NAMESPACE, key: 'smtpSecurity', value: account.smtp.security },
      { namespace: NAMESPACE, key: 'password', value: account.password },
    ]);
  } finally {
    store.close();
  }
  return { id, identity: address, provider: 'imap_smtp' };
}

function readRecord(path: string): OwnMailAccount | null {
  const store = SecretStore.open(path);
  try {
    const all = store.load(NAMESPACE);
    const address = all.get('address');
    const imapHost = all.get('imapHost');
    const smtpHost = all.get('smtpHost');
    const password = all.get('password');
    const imapPort = Number.parseInt(all.get('imapPort') ?? '', 10);
    const smtpPort = Number.parseInt(all.get('smtpPort') ?? '', 10);
    const security = all.get('smtpSecurity');
    if (!address || !imapHost || !smtpHost || !password) return null;
    if (!Number.isInteger(imapPort) || !Number.isInteger(smtpPort)) return null;
    if (security !== 'tls' && security !== 'starttls') return null;
    return {
      address,
      imap: { host: imapHost, port: imapPort, user: all.get('imapUser') || address },
      smtp: { host: smtpHost, port: smtpPort, user: all.get('smtpUser') || address, security },
      password,
    };
  } finally {
    store.close();
  }
}

/** Every complete account file, by id. An incomplete one is skipped, not guessed at. */
export function readOwnAccounts(secretsDir: string): Map<string, OwnMailAccount> {
  const accounts = new Map<string, OwnMailAccount>();
  if (!existsSync(secretsDir)) return accounts;
  for (const file of readdirSync(secretsDir).sort()) {
    const id = file.endsWith('.db') ? file.slice(0, -3) : null;
    if (!id || !ACCOUNT_ID.test(id)) continue;
    const record = readRecord(join(secretsDir, file));
    if (record) accounts.set(id, record);
  }
  return accounts;
}

export function listOwnAccounts(secretsDir: string): BackendAccount[] {
  return [...readOwnAccounts(secretsDir)].map(([id, account]) => ({
    id,
    identity: account.address,
    provider: 'imap_smtp',
  }));
}

export function removeOwnAccount(secretsDir: string, accountId: string): void {
  removeSecretFiles(ownAccountPath(secretsDir, accountId));
}

/** The password, read from the file at the moment it is needed and not kept anywhere else. */
function passwordOf(secretsDir: string, id: string): string {
  const record = readRecord(ownAccountPath(secretsDir, id));
  if (!record) throw new Error(fmt(_('the mail account {account} is incomplete — add it again'), { account: id }));
  return record.password;
}

/** The IMAP endpoint. TLS from the first byte only: that is all `MailTarget` speaks. */
export function ownMailTarget(secretsDir: string, id: string, account: OwnMailAccount): MailTarget {
  return {
    accountId: id,
    host: account.imap.host,
    port: account.imap.port,
    user: account.imap.user,
    implicitTls: true,
    getPassword: () => passwordOf(secretsDir, id),
  };
}

export function ownSmtpTarget(secretsDir: string, id: string, account: OwnMailAccount): SmtpTarget {
  return {
    accountId: id,
    from: account.address,
    host: account.smtp.host,
    port: account.smtp.port,
    user: account.smtp.user,
    security: account.smtp.security,
    getPassword: () => passwordOf(secretsDir, id),
  };
}
