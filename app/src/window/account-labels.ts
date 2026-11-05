/**
 * Account id → the identity a person knows it by, for the list and the agent-access dialog. Two
 * sources: the local index (every account it has synced, so it works without a backend) and the
 * enabled backends (current, but they may be slow); a backend wins where both know the id. An id
 * neither knows has no label and is shown as itself.
 */

import { indexDbPath, openIndexDb } from '@curlew/store';
import { existsSync } from 'node:fs';

import { backendAccountsList } from '../core/actions/accounts.ts';

const ACCOUNTS_TIMEOUT_MS = 4_000;

export function indexAccountLabels(dbPath = indexDbPath()): Map<string, string> {
  const labels = new Map<string, string>();
  if (!existsSync(dbPath)) return labels;
  try {
    const db = openIndexDb(dbPath, { busyTimeoutMs: 300 });
    try {
      const rows = db.prepare('SELECT id, identity FROM accounts').all() as Array<{
        id: string;
        identity: string | null;
      }>;
      for (const row of rows) if (row.identity?.trim()) labels.set(row.id, row.identity.trim());
    } finally {
      db.close();
    }
  } catch {
    // No index, no labels.
  }
  return labels;
}

export async function loadAccountLabels(
  backends: string[],
  configFile: string,
): Promise<Map<string, string>> {
  const labels = indexAccountLabels();
  await Promise.all(
    backends.map(async (name) => {
      try {
        const listed = await Promise.race([
          backendAccountsList(name, configFile),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error('timeout')), ACCOUNTS_TIMEOUT_MS),
          ),
        ]);
        for (const account of listed.accounts) labels.set(account.id, account.identity);
      } catch {
        // The index label, or none: the caller shows the id.
      }
    }),
  );
  return labels;
}
