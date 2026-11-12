/**
 * Account actions — GNOME Online Accounts enumeration, the availability probe, and the accounts
 * of backends that keep their own (chat networks).
 *
 * The action layer is where scoping, limits and redaction live: the packages return full DTOs,
 * the actions decide what a caller sees. Both frontends (CLI, MCP) go through here, so a cap
 * added once applies to both.
 */

import { check, listAccounts } from '@curlew/gnome';
import type {
  AccountAddOptions,
  AccountPrompter,
  BackendAccount,
  GnomeAccount,
  GnomeCheckResult,
  ListAccountsOptions,
} from '@curlew/protocol';
import { isAccountRemoverBackend } from '@curlew/protocol';
import { rmSync } from 'node:fs';
import {
  type AccountDataRemoved,
  avatarsDir,
  configPath,
  deleteAccountData,
  indexDbPath,
  previewsDir,
} from '@curlew/store';
import { builtinRegistry } from '../backends/builtin.ts';
import { backendContext } from '../backends/context.ts';
import { loadConfig, saveConfig } from '../config.ts';
import { avatarAccountDir } from '../lib/avatar-cache.ts';
import { openIndex } from './index-sync.ts';

/** List configured GNOME Online Accounts and their capabilities. No credentials. */
export async function accountsList(): Promise<GnomeAccount[]> {
  return listAccounts();
}

/** Probe GOA/EDS availability (the same three-state shape `curlew check` reports). */
export async function accountsCheck(): Promise<GnomeCheckResult> {
  return check();
}

/** The accounts one ENABLED backend knows. No credentials, no session data. */
export async function backendAccountsList(
  name: string,
  path = configPath(),
  options: ListAccountsOptions = {},
): Promise<{ backend: string; accounts: BackendAccount[] }> {
  const config = loadConfig(path);
  const backend = builtinRegistry().create(config, name, backendContext(name, config));
  return { backend: name, accounts: await backend.listAccounts(options) };
}

/**
 * Switch a chat account on or off. Off keeps it linked and keeps its messages; the daemon and
 * `curlew sync` then skip it. Interactive use only, like removal: an agent must not be able to
 * silence an account.
 */
export function accountSetEnabled(
  name: string,
  accountId: string,
  enabled: boolean,
  path = configPath(),
): void {
  const config = loadConfig(path);
  const key = `${name}/${accountId}`;
  const rest = config.disabledAccounts.filter((k) => k !== key);
  config.disabledAccounts = enabled ? rest : [...rest, key];
  saveConfig(config, path);
}

/**
 * Add an account to an ENABLED backend, interactively. Only backends that keep their own accounts
 * can; the mail backend does too (an address and a password), besides the GNOME Online Accounts it
 * reads from the system.
 */
export async function accountsAdd(
  name: string,
  prompter: AccountPrompter,
  options: AccountAddOptions = {},
  path = configPath(),
): Promise<{ backend: string; account: BackendAccount }> {
  const config = loadConfig(path);
  const backend = builtinRegistry().create(config, name, backendContext(name, config));
  if (!backend.addAccount) {
    throw new Error(`${name} accounts are not added in curlew — this backend has no login flow`);
  }
  return { backend: name, account: await backend.addAccount(prompter, options) };
}

/**
 * Unlink a chat account from this machine: its stored login goes, the messages already indexed
 * stay. Interactive use only — the CLI and MCP do not expose it, because an agent must not be
 * able to cut a person's session. The account stays linked on the service's side.
 */
export async function accountRemove(
  name: string,
  accountId: string,
  path = configPath(),
  options: AccountRemoveOptions = {},
): Promise<{ backend: string; account: string; data?: AccountDataRemoved }> {
  const config = loadConfig(path);
  const backend = builtinRegistry().create(config, name, backendContext(name, config));
  if (!isAccountRemoverBackend(backend)) {
    throw new Error(`${name} accounts are not removed in curlew — this backend has no stored login`);
  }
  await backend.removeAccount(accountId);
  if (!options.deleteData) return { backend: name, account: accountId };
  return { backend: name, account: accountId, data: accountDataDelete(name, accountId, options) };
}

export interface AccountRemoveOptions {
  /** Also delete the account's indexed messages and cached files from this computer. */
  deleteData?: boolean;
  /** Test seams: the index, the avatar cache and the preview cache. */
  dbPath?: string;
  avatarsRoot?: string;
  previewsRoot?: string;
}

/**
 * Delete what this computer holds of one account besides its login: the indexed rows, the cached
 * profile pictures and the preview files (those are keyed by message, not account, so the whole
 * cache goes — it refills on demand).
 */
export function accountDataDelete(
  name: string,
  accountId: string,
  options: AccountRemoveOptions = {},
): AccountDataRemoved {
  const db = openIndex(options.dbPath ?? indexDbPath());
  let removed: AccountDataRemoved;
  try {
    removed = deleteAccountData(db, name, accountId);
  } finally {
    db.close();
  }
  rmSync(avatarAccountDir(options.avatarsRoot ?? avatarsDir(), name, accountId), {
    recursive: true,
    force: true,
  });
  rmSync(options.previewsRoot ?? previewsDir(), { recursive: true, force: true });
  return removed;
}
