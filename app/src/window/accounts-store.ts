/**
 * Fetches the configured accounts for the Accounts dialog: enabled backends, their chat accounts,
 * the mail accounts (Curlew's own and GNOME Online Accounts), and the label map. Errors are captured per source so the dialog can show
 * them inline rather than failing the whole page.
 */

import { GnomeUnavailableError, type BackendAccount, type GnomeAccount } from '@curlew/protocol';
import { isOwnAccountId } from '@curlew/imap';
import { configPath } from '@curlew/store';

import { accountsList, backendAccountsList } from '../core/actions/accounts.ts';
import { deltaChatAccountIds, loadConfig } from '../core/config.ts';
import { backendsList } from '../core/actions/backends.ts';
import { chatOnly } from '../core/platform.ts';
import type { BackendStatus } from '../core/backends/registry.ts';
import { loadAccountLabels } from './account-labels.ts';
import type { AccountsLoadState } from './accounts-model.ts';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function enabledChatBackends(backends: BackendStatus[]): BackendStatus[] {
  return backends.filter((b) => b.enabled && b.name !== 'mail');
}

export interface LoadAccountsOptions {
  /**
   * Whether GNOME Online Accounts can exist at all. False in a Flatpak (ADR 0011): then their
   * absence is the sandbox, not a failure, so no error row is shown for it.
   */
  hostAccounts?: boolean;
}

export async function loadAccountsState(
  path = configPath(),
  options: LoadAccountsOptions = {},
): Promise<AccountsLoadState> {
  const { backends } = backendsList(path);
  const chatBackends = enabledChatBackends(backends);
  const hostAccounts = options.hostAccounts ?? true;

  // `CURLEW_NO_HOST_ACCOUNTS=1` hides the host's GNOME Online Accounts, so a screenshot never shows
  // the real ones (the screenshot script sets it).
  const goaAccountsPromise = (
    process.env.CURLEW_NO_HOST_ACCOUNTS === '1' || chatOnly()
      ? Promise.resolve([] as GnomeAccount[])
      : accountsList()
  ).then(
    (accounts): { accounts: GnomeAccount[]; error?: string } => ({ accounts }),
    (err: unknown): { accounts: GnomeAccount[]; error?: string } =>
      !hostAccounts || err instanceof GnomeUnavailableError
        ? { accounts: [] }
        : { accounts: [], error: errorText(err) },
  );

  const mailEnabled = backends.some((b) => b.name === 'mail' && b.enabled);
  const ownMailPromise = mailEnabled
    ? backendAccountsList('mail', path, { includeDisabled: true }).then(
        (result) => result.accounts,
        () => [] as BackendAccount[],
      )
    : Promise.resolve([] as BackendAccount[]);

  const chatPromises = chatBackends.map((backend) =>
    backendAccountsList(backend.name, path, { includeDisabled: true }).then(
      (result): { backend: string; accounts: BackendAccount[]; error?: string } => ({
        backend: backend.name,
        accounts: result.accounts,
      }),
      (err: unknown): { backend: string; accounts: BackendAccount[]; error: string } => ({
        backend: backend.name,
        accounts: [],
        error: errorText(err),
      }),
    ),
  );

  const [goaAccounts, mailAccounts, ...chatAccounts] = await Promise.all([
    goaAccountsPromise,
    ownMailPromise,
    ...chatPromises,
  ]);
  // The mail backend lists both kinds; the ones GNOME Online Accounts already shows are not ours.
  const ownMailAccounts = mailAccounts.filter((a) => isOwnAccountId(a.id));

  const labels = await loadAccountLabels(
    chatBackends.map((b) => b.name),
    path,
  ).catch(() => new Map<string, string>());

  const config = loadConfig(path);
  return {
    backends,
    goaAccounts,
    ownMailAccounts,
    chatAccounts,
    labels,
    deltaChatIds: new Set(deltaChatAccountIds(config)),
    pausedKeys: new Set(config.disabledAccounts),
  };
}
