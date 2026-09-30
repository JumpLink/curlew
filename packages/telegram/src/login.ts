/**
 * `postbote accounts add telegram` — the interactive login, as a function the CLI calls with its
 * terminal prompts.
 *
 * The session is created under a temporary name and moved to `<account id>.db` only once the
 * login succeeded, so a cancelled or failed login never leaves a half-authorized session that
 * `sync` would then try to use. Logging in to an account that already has a session replaces it.
 *
 * The api_id/api_hash come from the environment or are asked for first, and are stored in the
 * session file — never in the config. A login that is killed outright leaves its pending file;
 * the next `accounts add` or account listing sweeps it once it is stale.
 *
 * Nothing secret is returned or printed: not the phone number, not the code, not the password,
 * not the api_hash, not the session. The result is the account id and the public identity (`@username` or name).
 */

import type { BackendAccount, BackendContext } from '@postbote/protocol';
import { ensurePrivateDir, SecretStore } from '@postbote/store';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LoginPrompts, TelegramClientHandle, TgUser } from './api.ts';
import {
  accountIdFor,
  PENDING_STALE_MS,
  pendingSessionPath,
  sessionPath,
  sweepPendingSessions,
  writeAccountRecord,
} from './accounts.ts';
import { type ClientFactory, createMtcuteClient } from './client.ts';
import {
  credentialsFromEnv,
  parseCredentials,
  refuseConfigCredentials,
  type TelegramCredentials,
  writeStoredCredentials,
} from './credentials.ts';
import { holdsAuthKey, SecretStoreStorage } from './storage.ts';

/** The public name an account is listed under — never the phone number. */
export function identityOf(user: Pick<TgUser, 'username' | 'displayName' | 'id'>): string {
  if (user.username) return `@${user.username}`;
  return user.displayName || `Telegram user ${user.id}`;
}

/** The environment's pair, else asked for — before anyone types a phone number. */
async function loginCredentials(
  context: BackendContext,
  prompts: LoginPrompts,
): Promise<TelegramCredentials> {
  refuseConfigCredentials(context.settings);
  const fromEnv = credentialsFromEnv(context.env);
  if (fromEnv) return fromEnv;
  const apiId = await prompts.apiId();
  const apiHash = await prompts.apiHash();
  return parseCredentials(apiId, apiHash);
}

/**
 * What to do with a login that did not complete, and what to tell the user.
 *
 * The decision is made on a FACT about the file, not on where the control flow happened to be:
 * an auth key lands in the file the moment Telegram confirms the sign-in, and every step after it
 * can still throw — mtcute's `_onAuthorization`/`notifyLoggedIn`, the update manager, postbote's
 * own record writes, the final rename. Deciding on a flag around the login promise would still
 * throw away a session that is genuinely authorized, and the user would pay for another phone code.
 *
 * A file with no key is a login that got nowhere and is removed; the message is then the original
 * error, unembellished. A file WITH a key is the only copy of a working session, so it stays and
 * the error says where it is and how long it will survive (`sweepPendingSessions` cannot tell it
 * from an abandoned login and removes it once stale).
 */
async function recoverFailedLogin(
  err: unknown,
  secretsDir: string,
  pending: string,
  accountId: string | null,
  store: SecretStore,
  client: TelegramClientHandle,
): Promise<Error> {
  // Read BEFORE closing — this is the only moment the file can still be asked.
  const keep = holdsAuthKey(store);
  await client.destroy().catch(() => {});
  try {
    store.close();
  } catch {
    // Already closed on the way out (a destroy that succeeded, a rename that then failed).
  }
  const original = err instanceof Error ? err : new Error(String(err));
  if (!keep) {
    for (const path of [pending, `${pending}-journal`]) if (existsSync(path)) rmSync(path, { force: true });
    return original;
  }
  const target = accountId ? sessionPath(secretsDir, accountId) : join(secretsDir, '<account id>.db');
  return new Error(
    `${original.message} — Telegram HAD authorized this session, so its file is kept at ${pending} and ` +
      `NOT deleted. Move it to ${target} within ${Math.round(PENDING_STALE_MS / 60000)} minutes (a later ` +
      `\`postbote accounts\` call sweeps a stale pending login and cannot tell this one from an abandoned ` +
      `one), or log in again.`,
  );
}

export async function loginTelegram(
  context: BackendContext,
  prompts: LoginPrompts,
  createClient: ClientFactory = createMtcuteClient,
): Promise<BackendAccount> {
  const credentials = await loginCredentials(context, prompts);
  ensurePrivateDir(context.secretsDir);
  // What a killed earlier login left behind goes first: it may hold a live auth key.
  sweepPendingSessions(context.secretsDir);
  const pending = pendingSessionPath(context.secretsDir);
  const store = SecretStore.open(pending);
  let client: TelegramClientHandle;
  try {
    client = createClient({ credentials, storage: new SecretStoreStorage(store) });
  } catch (err) {
    store.close();
    throw err;
  }
  // Known as soon as Telegram has named the account, so a failure while writing the records can
  // still tell the user which file to move where.
  let accountId: string | null = null;
  try {
    const me = await client.login(prompts);
    accountId = accountIdFor(me.id);
    const account: BackendAccount = {
      id: accountId,
      identity: identityOf(me),
      provider: 'Telegram',
    };
    writeAccountRecord(store, { identity: account.identity });
    // Kept with the session they belong to (Telegram ties a session to its app), in the same
    // 0600 file — so `sync` needs no environment and the config holds no secret.
    writeStoredCredentials(store, credentials);
    await client.destroy();
    store.close();
    renameSync(pending, sessionPath(context.secretsDir, account.id));
    return account;
  } catch (err) {
    throw await recoverFailedLogin(err, context.secretsDir, pending, accountId, store, client);
  }
}
