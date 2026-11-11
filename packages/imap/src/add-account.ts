/**
 * Add a mail account without GNOME Online Accounts: ask for the address and the password, find the
 * servers the way Thunderbird does, ask for them only when nobody publishes them, prove the login
 * works, and only then save the account (ADR 0011).
 *
 * Runtime-neutral: the network is injected (`fetchText`, `testLogin`), so the whole flow runs in a
 * unit test against fakes. The password is passed to `testLogin` and `writeOwnAccount` and
 * nowhere else — not into `notify`, not into an error.
 */

import type { AccountPrompter, BackendAccount } from '@curlew/protocol';
import { _, fmt } from '@curlew/protocol';
import { discoverServers, expandUsername, type DiscoveredServers } from './autoconfig.ts';
import { normalizeOwnAddress, writeOwnAccount, type OwnMailAccount } from './own-accounts.ts';

export interface AddAccountDeps {
  /** The body of an HTTPS GET, or null for anything that is not a success. */
  fetchText: (url: string) => Promise<string | null>;
  /** Connect and log in to the IMAP server, then log out. Rejects when the login fails. */
  testLogin: (account: OwnMailAccount) => Promise<void>;
}

const DEFAULT_IMAP_PORT = 993;

/** `host` or `host:port` as typed; null when it cannot be a server. */
export function parseHostPort(raw: string, defaultPort: number): { host: string; port: number } | null {
  const text = raw.trim();
  if (!text || /\s/.test(text) || text.includes('/')) return null;
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match) return null;
  const port = match[2] === undefined ? defaultPort : Number.parseInt(match[2], 10);
  if (port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

/** SMTP over TLS from the first byte is port 465 by convention; anything else upgrades with STARTTLS. */
export function smtpSecurityFor(port: number): 'tls' | 'starttls' {
  return port === 465 ? 'tls' : 'starttls';
}

async function askServer(
  prompter: AccountPrompter,
  label: string,
  defaultPort: number,
): Promise<{ host: string; port: number }> {
  for (;;) {
    const answer = await prompter.ask(label);
    const parsed = parseHostPort(answer, defaultPort);
    if (parsed) return parsed;
    prompter.notify(_('That is not a server name — write it as host or host:port'));
  }
}

async function serversFor(
  prompter: AccountPrompter,
  address: string,
  fetchText: AddAccountDeps['fetchText'],
): Promise<DiscoveredServers> {
  prompter.notify(fmt(_('Looking for the mail servers of {domain}…'), { domain: address.split('@')[1] }));
  const found = await discoverServers(address, fetchText);
  if (found && 'servers' in found) return found.servers;
  prompter.notify(
    found && 'refusal' in found && found.refusal === 'oauth2'
      ? _('This provider wants a browser sign-in, which Curlew cannot do yet — enter the servers and an app password')
      : _('No settings published for this address — enter the servers'),
  );
  const imap = await askServer(prompter, _('IMAP server (host or host:port, TLS on 993)'), DEFAULT_IMAP_PORT);
  const smtp = await askServer(prompter, _('SMTP server (host or host:port, 465 or 587)'), 587);
  return {
    imap: { ...imap, user: address },
    smtp: { ...smtp, user: address, security: smtpSecurityFor(smtp.port) },
  };
}

/** The whole flow. Throws with a message for the person when the address or the login is refused. */
export async function addMailAccount(
  dir: string,
  prompter: AccountPrompter,
  deps: AddAccountDeps,
): Promise<BackendAccount> {
  const address = normalizeOwnAddress(await prompter.ask(_('Email address (name@example.org)')));
  const password = await prompter.ask(_('Password (an app password if the provider offers them)'), { secret: true });
  if (!password) throw new Error(_('the password is empty'));
  const servers = await serversFor(prompter, address, deps.fetchText);
  const account: OwnMailAccount = {
    address,
    imap: { host: servers.imap.host, port: servers.imap.port, user: expandUsername(servers.imap.user, address) },
    smtp: {
      host: servers.smtp.host,
      port: servers.smtp.port,
      user: expandUsername(servers.smtp.user, address),
      security: servers.smtp.security,
    },
    password,
  };
  prompter.notify(fmt(_('Logging in to {host}…'), { host: account.imap.host }));
  try {
    await deps.testLogin(account);
  } catch (err) {
    // The server's refusal can quote the login line; say only that it was refused.
    const reason = err instanceof Error ? err.message.replace(password, '…') : String(err);
    throw new Error(fmt(_('could not log in to {host}: {reason}'), { host: account.imap.host, reason }));
  }
  return writeOwnAccount(dir, account);
}
