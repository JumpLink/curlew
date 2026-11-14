/**
 * The Matrix login — by password or by an access token, as a function the CLI calls with its
 * terminal prompts.
 *
 * Homeserver (a URL, or a server name whose `.well-known` names it), user and password are
 * exchanged for an access token and a NEW device. The device then runs one sync, which uploads
 * its identity and one-time keys: from that moment on, people in encrypted rooms encrypt for it.
 * History encrypted BEFORE that is not readable by this device (see AGENTS.md: no key backup,
 * no verification yet).
 *
 * `m.login.password`, or an access token (the person's own session, user id from `/whoami`).
 * A browser-redirect login (SSO/OIDC) is not built yet (JumpLink/curlew#375).
 *
 * The account file is written under a temporary name and moved to `<account id>.db` only once
 * the first sync succeeded, so a failed login never leaves a half-set-up account. A login that
 * fails after the server issued the token logs that device out again. The password is never
 * stored, returned or printed; the token and the crypto store go only into the 0600 file.
 */

import { _, fmt } from '@curlew/protocol';
import type { BackendAccount, BackendContext } from '@curlew/protocol';
import { ensurePrivateDir, SecretStore } from '@curlew/store';
import { existsSync, renameSync, rmSync } from 'node:fs';
import type { MatrixLoginPrompts } from './api.ts';
import {
  accountIdFor,
  accountPath,
  pendingAccountPath,
  sweepPendingAccounts,
  writeAccessToken,
  writeAccountRecord,
} from './accounts.ts';
import { readOnlyFetch } from './guard.ts';
import { connectMatrixClient, loadMatrixSdk, quietLogger, type MatrixConnector } from './client.ts';

/** `https://matrix.example.org/` → `https://matrix.example.org`; a server name is discovered. */
export async function resolveHomeserver(input: string): Promise<string> {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, '');
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(value)) throw new Error(_('the homeserver must be a URL or a server name'));
  const { AutoDiscovery, AutoDiscoveryAction } = await loadMatrixSdk();
  const found = await AutoDiscovery.findClientConfig(value);
  const hs = found['m.homeserver'];
  if (hs?.state === AutoDiscoveryAction.SUCCESS && hs.base_url) return hs.base_url.replace(/\/+$/, '');
  // No (valid) .well-known: the server name itself is the usual fallback.
  return `https://${value}`;
}

/** What a login ends in, whichever way the person proved who they are. */
interface Session {
  userId: string;
  deviceId: string;
  accessToken: string;
  /** The server issued this device for curlew: a failed setup logs it out again. */
  issuedHere: boolean;
}

/** `GET /account/whoami` with a token the person brought: the user and device it belongs to. */
export async function whoami(homeserver: string, token: string, httpFetch: typeof globalThis.fetch): Promise<Session> {
  const response = await readOnlyFetch(httpFetch)(`${homeserver}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(fmt(_('{homeserver} did not accept this access token'), { homeserver }));
  const body = (await response.json()) as { user_id?: unknown; device_id?: unknown };
  if (typeof body.user_id !== 'string' || !body.user_id) {
    throw new Error(fmt(_('{homeserver} did not say whom this access token belongs to'), { homeserver }));
  }
  // End-to-end encryption needs the token's own device; a token without one cannot be used.
  if (typeof body.device_id !== 'string' || !body.device_id) {
    throw new Error(_('this access token belongs to no device, so it cannot hold encryption keys'));
  }
  return { userId: body.user_id, deviceId: body.device_id, accessToken: token, issuedHere: false };
}

export async function loginMatrix(
  context: BackendContext,
  prompts: MatrixLoginPrompts,
  connect: MatrixConnector = connectMatrixClient,
  httpFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<BackendAccount> {
  const homeserver = await resolveHomeserver(await prompts.homeserver());
  const { createClient } = await loadMatrixSdk();
  const fetchFn = readOnlyFetch(httpFetch);
  const probe = createClient({ baseUrl: homeserver, fetchFn, logger: quietLogger() });
  const method = await prompts.method();
  let login: Session;
  if (method === 'token') {
    login = await whoami(homeserver, (await prompts.token()).trim(), httpFetch);
  } else {
    const { flows } = await probe.loginFlows();
    if (!flows.some((f) => f.type === 'm.login.password')) {
      throw new Error(
        fmt(
          _('{homeserver} offers no password login (only {flows}) — choose “Access Token” instead'),
          { homeserver, flows: flows.map((f) => f.type).join(', ') || _('nothing') },
        ),
      );
    }
    // `@anna:example.org` or just `anna`: the server resolves either.
    const user = (await prompts.user()).trim();
    if (!user) throw new Error(_('the Matrix user is empty'));
    const password = await prompts.password();
    const issued = await probe.loginRequest({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password,
      // What the user sees in their list of sessions, in Element and everywhere else.
      initial_device_display_name: 'curlew',
    });
    login = { userId: issued.user_id, deviceId: issued.device_id, accessToken: issued.access_token, issuedHere: true };
  }

  ensurePrivateDir(context.secretsDir);
  sweepPendingAccounts(context.secretsDir);
  const pending = pendingAccountPath(context.secretsDir);
  const store = SecretStore.open(pending);
  const accountId = accountIdFor(login.userId);
  let moved = false;
  try {
    writeAccountRecord(store, { userId: login.userId, homeserver, deviceId: login.deviceId });
    writeAccessToken(store, login.accessToken);
    prompts.notify(_('Logged in; setting up this device’s encryption keys…'));
    const api = await connect({
      homeserver,
      userId: login.userId,
      deviceId: login.deviceId,
      accessToken: login.accessToken,
      store,
      accountId,
    });
    await api.close();
    store.close();
    renameSync(pending, accountPath(context.secretsDir, accountId));
    moved = true;
    return { id: accountId, identity: login.userId, provider: 'Matrix' };
  } finally {
    if (!moved) {
      try {
        store.close();
      } catch {
        // Already closed before a failed rename.
      }
      for (const path of [pending, `${pending}-journal`]) if (existsSync(path)) rmSync(path, { force: true });
      // The server issued a device; without its file it is an orphan in the user's session list.
      // A token the person brought is their own session: never log it out.
      if (login.issuedHere) {
        const orphan = createClient({
          baseUrl: homeserver,
          accessToken: login.accessToken,
          fetchFn,
          logger: quietLogger(),
        });
        await orphan.logout(true).catch(() => {});
      }
    }
  }
}
