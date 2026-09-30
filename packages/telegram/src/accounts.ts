/**
 * Telegram accounts are session files: one `<account id>.db` per logged-in account in the
 * backend's secrets directory. There is no other registry — an account exists exactly as long as
 * its session does, so `postbote accounts add telegram` creates one and deleting the file (or
 * logging the session out from another Telegram client) ends it.
 */

import type { BackendAccount } from '@postbote/protocol';
import { SecretStore } from '@postbote/store';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNT_NAMESPACE, holdsSignIn } from './storage.ts';

const ACCOUNT_ID = /^telegram-\d+$/;

/** The account id for a Telegram user id. */
export function accountIdFor(userId: number): string {
  return `telegram-${userId}`;
}

export function sessionPath(secretsDir: string, accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) throw new Error(`not a Telegram account id: ${accountId}`);
  return join(secretsDir, `${accountId}.db`);
}

/** What the session file says about its own account — never the phone number. */
export interface AccountRecord {
  identity: string;
}

export function writeAccountRecord(store: SecretStore, record: AccountRecord): void {
  store.apply([{ namespace: ACCOUNT_NAMESPACE, key: 'identity', value: record.identity }]);
}

/** A login in progress: `login-<time>-<random>.pending.db` (plus SQLite's journal). */
const PENDING = /^login-\d+-\d+\.pending\.db(-journal)?$/;

/** A pending file this old is from a login that was killed, not one still running. */
export const PENDING_STALE_MS = 15 * 60 * 1000;

export function pendingSessionPath(secretsDir: string, now = Date.now()): string {
  return join(secretsDir, `login-${now}-${Math.floor(Math.random() * 1e9)}.pending.db`);
}

/**
 * Remove what a hard-killed login left behind. One younger than `PENDING_STALE_MS` may belong to
 * a login running right now in another terminal, and stays. An older one is removed — unless it
 * is SIGNED IN (`holdsSignIn`): then it is the only copy of a working session that a failed login
 * told the user to move into place, and deleting it would cost them another phone code. Such a
 * file stays until they move or delete it. Pending files are never listed as accounts either way.
 */
export function sweepPendingSessions(secretsDir: string, now = Date.now()): number {
  if (!existsSync(secretsDir)) return 0;
  const files = readdirSync(secretsDir).filter((file) => PENDING.test(file));
  let removed = 0;
  for (const file of files) {
    // A journal follows its database: kept with it, removed with it, removed alone once stale.
    if (file.endsWith('-journal') && files.includes(file.slice(0, -'-journal'.length))) continue;
    const path = join(secretsDir, file);
    if (now - statSync(path).mtimeMs < PENDING_STALE_MS) continue;
    if (!file.endsWith('-journal') && signedIn(path)) continue;
    for (const doomed of [path, `${path}-journal`]) {
      if (!existsSync(doomed)) continue;
      rmSync(doomed, { force: true });
      removed++;
    }
  }
  return removed;
}

/** Fails SAFE like `holdsSignIn`: a file that cannot even be opened is not deleted on a guess. */
function signedIn(path: string): boolean {
  let store: SecretStore;
  try {
    store = SecretStore.open(path);
  } catch {
    return true;
  }
  try {
    return holdsSignIn(store);
  } finally {
    store.close();
  }
}

/** Every account with a session file, in id order. Sweeps stale pending logins on the way. */
export function listSessionAccounts(secretsDir: string): BackendAccount[] {
  if (!existsSync(secretsDir)) return [];
  sweepPendingSessions(secretsDir);
  const accounts: BackendAccount[] = [];
  for (const file of readdirSync(secretsDir).sort()) {
    const id = file.endsWith('.db') ? file.slice(0, -3) : null;
    if (!id || !ACCOUNT_ID.test(id)) continue;
    const store = SecretStore.open(join(secretsDir, file));
    try {
      accounts.push({ id, identity: store.get(ACCOUNT_NAMESPACE, 'identity') ?? id, provider: 'Telegram' });
    } finally {
      store.close();
    }
  }
  return accounts;
}
