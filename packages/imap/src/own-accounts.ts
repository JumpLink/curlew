/**
 * A mail account Curlew holds itself, for a person who has no GNOME Online Account for it — or
 * none at all, as in a Flatpak (ADR 0011). One `<account id>.db` per account in the backend's
 * secrets directory (`SecretStore`: 0600 in 0700, backup tier `secret`), holding the address and
 * the two servers. An account exists exactly as long as its file does.
 *
 * The password is not in that file. It is an app-owned secret, so it lives in
 * `@gjsify/secret-store` (the platform keyring), one namespace per account, key `password`
 * (ADR 0011, amendment 2026-11-23). Accounts written before that still hold it in the file: the first read moves it.
 *
 * Same rule as every other password Curlew keeps: it never leaves the keyring for the config, a
 * log, an error message, a DTO or MCP output. The targets below carry it as a thunk, read per
 * connection.
 */

import type { BackendAccount, MailTarget, SmtpTarget } from '@curlew/protocol';
import { _, fmt, normalizeAddress } from '@curlew/protocol';
import { SecretStore, removeSecretFiles, secretFiles, stableId } from '@curlew/store';
import { openSecretStore } from '@gjsify/secret-store';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ACCOUNT_ID = /^mail-[0-9a-z]+$/;
const NAMESPACE = 'mail.account';
const PASSWORD_KEY = 'password';

/** The keyring namespace of one account; clearing it forgets exactly that account's password. */
function passwordNamespace(accountId: string): string {
  return `curlew/mail/${accountId}`;
}

export interface OwnMailAccount {
  /** The address mail is sent from; also the account's identity. */
  address: string;
  imap: { host: string; port: number; user: string };
  smtp: { host: string; port: number; user: string; security: 'tls' | 'starttls' };
  password: string;
}

/** What the account file holds: everything but the password. */
export type OwnMailAccountRecord = Omit<OwnMailAccount, 'password'>;

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
export async function writeOwnAccount(secretsDir: string, account: OwnMailAccount): Promise<BackendAccount> {
  const address = normalizeOwnAddress(account.address);
  checkPort(account.imap.port);
  checkPort(account.smtp.port);
  if (!account.imap.host.trim() || !account.smtp.host.trim()) throw new Error(_('a server name is missing'));
  if (!account.password) throw new Error(_('the password is empty'));
  const id = ownAccountIdFor(address);
  // Keyring first, and a failure aborts: an account whose password has nowhere safe to go is not
  // saved, and there is no plaintext fallback (ADR 0152).
  await (await openSecretStore(passwordNamespace(id))).set(PASSWORD_KEY, account.password);
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
      // A rewrite of an account from before the keyring must not leave the old copy behind.
      { namespace: NAMESPACE, key: PASSWORD_KEY, value: null },
    ]);
  } finally {
    store.close();
  }
  return { id, identity: address, provider: 'imap_smtp' };
}

function readRecord(path: string): OwnMailAccountRecord | null {
  const store = SecretStore.open(path);
  try {
    const all = store.load(NAMESPACE);
    const address = all.get('address');
    const imapHost = all.get('imapHost');
    const smtpHost = all.get('smtpHost');
    const imapPort = Number.parseInt(all.get('imapPort') ?? '', 10);
    const smtpPort = Number.parseInt(all.get('smtpPort') ?? '', 10);
    const security = all.get('smtpSecurity');
    if (!address || !imapHost || !smtpHost) return null;
    if (!Number.isInteger(imapPort) || !Number.isInteger(smtpPort)) return null;
    if (security !== 'tls' && security !== 'starttls') return null;
    return {
      address,
      imap: { host: imapHost, port: imapPort, user: all.get('imapUser') || address },
      smtp: { host: smtpHost, port: smtpPort, user: all.get('smtpUser') || address, security },
    };
  } finally {
    store.close();
  }
}

/** Every complete account file, by id. An incomplete one is skipped, not guessed at. */
export function readOwnAccounts(secretsDir: string): Map<string, OwnMailAccountRecord> {
  const accounts = new Map<string, OwnMailAccountRecord>();
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

/** Remove the account file and its keyring entry. Throws when the account does not exist. */
export async function removeOwnAccount(secretsDir: string, accountId: string): Promise<void> {
  const path = ownAccountPath(secretsDir, accountId);
  if (!secretFiles().exists(path)) throw new Error(`no such account file: ${path}`);
  // Keyring first: if it fails the account is still listed and the removal can be repeated, where
  // the other order would leave a password nobody lists any more.
  await (await openSecretStore(passwordNamespace(accountId))).clear();
  removeSecretFiles(path);
}

/** The pre-keyring copy of the password, if the account file still holds one. */
function legacyPassword(path: string): string | null {
  const store = SecretStore.open(path);
  try {
    return store.get(NAMESPACE, PASSWORD_KEY) || null;
  } finally {
    store.close();
  }
}

function dropLegacyPassword(path: string): void {
  const store = SecretStore.open(path);
  try {
    store.apply([{ namespace: NAMESPACE, key: PASSWORD_KEY, value: null }]);
  } finally {
    store.close();
  }
}

/**
 * The password, read at the moment it is needed and not kept anywhere else.
 *
 * An account from before the keyring still has it in its file: that copy is written to the
 * keyring, read back, and only a verified copy is deleted from the file. When the keyring cannot
 * be reached the old value keeps working and stays where it is; the next read tries again.
 */
async function passwordOf(secretsDir: string, id: string): Promise<string> {
  const path = ownAccountPath(secretsDir, id);
  if (!readRecord(path)) throw new Error(fmt(_('the mail account {account} is incomplete — add it again'), { account: id }));
  const namespace = passwordNamespace(id);
  let keyringError: unknown = null;
  let held: string | null = null;
  try {
    held = await (await openSecretStore(namespace)).get(PASSWORD_KEY);
  } catch (err) {
    keyringError = err;
  }
  const legacy = legacyPassword(path);
  if (held) {
    if (legacy !== null) dropLegacyPassword(path);
    return held;
  }
  if (legacy !== null) {
    try {
      const store = await openSecretStore(namespace);
      await store.set(PASSWORD_KEY, legacy);
      if ((await store.get(PASSWORD_KEY)) === legacy) dropLegacyPassword(path);
    } catch {
      // Keep the old copy: an account that worked yesterday must work today.
    }
    return legacy;
  }
  if (keyringError) throw keyringError;
  throw new Error(fmt(_('the mail account {account} is incomplete — add it again'), { account: id }));
}

/** The IMAP endpoint. TLS from the first byte only: that is all `MailTarget` speaks. */
export function ownMailTarget(secretsDir: string, id: string, account: OwnMailAccountRecord): MailTarget {
  return {
    accountId: id,
    host: account.imap.host,
    port: account.imap.port,
    user: account.imap.user,
    implicitTls: true,
    getPassword: () => passwordOf(secretsDir, id),
  };
}

export function ownSmtpTarget(secretsDir: string, id: string, account: OwnMailAccountRecord): SmtpTarget {
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
