/**
 * Fetches the configured accounts for the Accounts dialog: enabled backends, their chat accounts,
 * GNOME Online Accounts, and the label map. Errors are captured per source so the dialog can show
 * them inline rather than failing the whole page.
 */

import type { BackendAccount, GnomeAccount } from '@curlew/protocol';
import { configPath } from '@curlew/store';

import { accountsList, backendAccountsList } from '../core/actions/accounts.ts';
import { backendsList } from '../core/actions/backends.ts';
import type { BackendStatus } from '../core/backends/registry.ts';
import { loadAccountLabels } from './account-labels.ts';
import type { AccountsLoadState } from './accounts-model.ts';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function enabledChatBackends(backends: BackendStatus[]): BackendStatus[] {
  return backends.filter((b) => b.enabled && b.name !== 'mail');
}

export async function loadAccountsState(path = configPath()): Promise<AccountsLoadState> {
  const { backends } = backendsList(path);
  const chatBackends = enabledChatBackends(backends);

  const goaAccountsPromise = accountsList().then(
    (accounts): { accounts: GnomeAccount[]; error?: string } => ({ accounts }),
    (err: unknown): { accounts: GnomeAccount[]; error: string } => ({
      accounts: [],
      error: errorText(err),
    }),
  );

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

  const [goaAccounts, ...chatAccounts] = await Promise.all([goaAccountsPromise, ...chatPromises]);

  const labels = await loadAccountLabels(
    chatBackends.map((b) => b.name),
    path,
  ).catch(() => new Map<string, string>());

  return { backends, goaAccounts, chatAccounts, labels };
}
