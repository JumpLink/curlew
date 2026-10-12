/**
 * The Telegram API credentials — an `api_id` and `api_hash` that identify the APPLICATION.
 *
 * Telegram requires every third-party client to use credentials registered at my.telegram.org.
 * The repository and CI/dev builds ship none. A packaged build MAY embed one pair, supplied by
 * its distributor at build time (`app/scripts/build-bundle.mjs`, the Flatpak manifest); a user
 * can always bring their own instead (`curlew accounts add telegram --own-credentials`).
 * Precedence: environment > the pair stored in the account's session > the embedded pair >
 * the interactive prompt. curlew never invents a pair and ships no Telegram test credentials.
 *
 * Where a user's own live: in the account's SESSION file (`SecretStore`, 0600, backup tier `secret`),
 * asked for once by `curlew accounts add telegram`. The environment
 * (`CURLEW_TELEGRAM_API_ID`, `CURLEW_TELEGRAM_API_HASH`; the old `POSTBOTE_` names still work) overrides them, for a user who keeps
 * them in a password manager. NOT in the config file: that is `state` in a backup, readable
 * wherever the backup goes, and the api_hash is a credential — so a config that carries one is
 * refused rather than silently used.
 *
 * The hash is never echoed back, not even in an error: an error message ends up in a terminal
 * scrollback or an MCP transcript.
 */

import { _, type BackendContext, fmt } from '@curlew/protocol';
import { envValue, type SecretStore } from '@curlew/store';

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

export const API_ID_ENV = 'CURLEW_TELEGRAM_API_ID';
export const API_HASH_ENV = 'CURLEW_TELEGRAM_API_HASH';

/**
 * The compile-time constant `"<id>:<hash>"`, defined by `build-bundle.mjs` only when the
 * distributor supplied a pair. Undeclared at runtime in every other build, hence the `typeof`.
 */
declare const __CURLEW_TELEGRAM_EMBEDDED__: string | undefined;

/** Which pair a session was created with. A session without the key predates it: `own`. */
export type CredentialSource = 'embedded' | 'own';

/** The session file's namespace for the credentials the session was created with. */
// Rename fallback: the key inside existing account files, read back as-is. Do not rebrand.
export const CREDENTIALS_NAMESPACE = 'postbote.api';

/** Key, inside `CREDENTIALS_NAMESPACE`, recording the `CredentialSource`. */
export const SOURCE_KEY = 'source';

/**
 * Where a user gets their own pair — a tail several of the errors below share.
 *
 * A function, not a `const`: a module-level `_()` resolves while the module graph is still being
 * built, which is before `initI18n()` has had a chance to run, and would pin English into the
 * module for the whole process.
 */
// TRANSLATORS: Tail of several credential errors. "API development tools" is the literal name of
// that section at my.telegram.org — keep it exactly as Telegram writes it.
const where = () => _('create them for yourself at https://my.telegram.org ("API development tools")');

/** Validate one pair. Throws without ever quoting the hash. */
export function parseCredentials(rawId: unknown, rawHash: unknown): TelegramCredentials {
  const apiId = typeof rawId === 'number' ? rawId : Number(String(rawId ?? '').trim());
  if (!Number.isSafeInteger(apiId) || apiId <= 0) {
    throw new Error(fmt(_('the Telegram api_id must be a positive whole number — {where}'), { where: where() }));
  }
  const apiHash = String(rawHash ?? '').trim();
  if (!/^[0-9a-f]{32}$/i.test(apiHash)) {
    throw new Error(
      fmt(_('the Telegram api_hash must be 32 hexadecimal characters (value not shown) — {where}'), {
        where: where(),
      }),
    );
  }
  return { apiId, apiHash: apiHash.toLowerCase() };
}

/** Refuse credentials in the config file: it is backed up as plain `state`. */
export function refuseConfigCredentials(settings: BackendContext['settings']): void {
  if ('apiHash' in settings || 'apiId' in settings) {
    throw new Error(
      fmt(
        _(
          'the Telegram api_id/api_hash do not belong in the config file (it is backed up in the clear) — ' +
            'remove backends.telegram.settings.apiId/apiHash; `curlew accounts add telegram` keeps them in ' +
            "the account's 0600 session file, or set {idEnv} and {hashEnv}",
        ),
        { idEnv: API_ID_ENV, hashEnv: API_HASH_ENV },
      ),
    );
  }
}

/** The environment's pair, or null when neither variable is set. Half a pair is an error. */
export function credentialsFromEnv(env: BackendContext['env']): TelegramCredentials | null {
  const id = envValue(env, 'TELEGRAM_API_ID');
  const hash = envValue(env, 'TELEGRAM_API_HASH');
  if (!id && !hash) return null;
  if (!id || !hash) {
    throw new Error(fmt(_('set both {idEnv} and {hashEnv}, or neither'), { idEnv: API_ID_ENV, hashEnv: API_HASH_ENV }));
  }
  return parseCredentials(id, hash);
}

/** The pair this build embeds, or null. `raw` is injectable for tests. */
export function embeddedCredentials(
  raw: string | undefined = typeof __CURLEW_TELEGRAM_EMBEDDED__ === 'undefined'
    ? undefined
    : __CURLEW_TELEGRAM_EMBEDDED__,
): TelegramCredentials | null {
  if (!raw) return null;
  const at = raw.indexOf(':');
  return parseCredentials(raw.slice(0, at), raw.slice(at + 1));
}

export function sameCredentials(a: TelegramCredentials, b: TelegramCredentials): boolean {
  return a.apiId === b.apiId && a.apiHash === b.apiHash;
}

export function readStoredSource(store: SecretStore): CredentialSource {
  return store.get(CREDENTIALS_NAMESPACE, SOURCE_KEY) === 'embedded' ? 'embedded' : 'own';
}

export function readStoredCredentials(store: SecretStore): TelegramCredentials | null {
  const id = store.get(CREDENTIALS_NAMESPACE, 'apiId');
  const hash = store.get(CREDENTIALS_NAMESPACE, 'apiHash');
  return id && hash ? parseCredentials(id, hash) : null;
}

export function writeStoredCredentials(
  store: SecretStore,
  credentials: TelegramCredentials,
  source: CredentialSource = 'own',
): void {
  store.apply([
    { namespace: CREDENTIALS_NAMESPACE, key: 'apiId', value: String(credentials.apiId) },
    { namespace: CREDENTIALS_NAMESPACE, key: 'apiHash', value: credentials.apiHash },
    { namespace: CREDENTIALS_NAMESPACE, key: SOURCE_KEY, value: source },
  ]);
}

/**
 * For a login: the environment, then this build's embedded pair (unless the user asked for their
 * own), else null — the caller then asks. `source` is what the session records.
 */
export function pickLoginCredentials(
  env: BackendContext['env'],
  embedded: TelegramCredentials | null,
  ownCredentials: boolean,
): { credentials: TelegramCredentials; source: CredentialSource } | null {
  const fromEnv = credentialsFromEnv(env);
  if (fromEnv) return { credentials: fromEnv, source: 'own' };
  if (embedded && !ownCredentials) return { credentials: embedded, source: 'embedded' };
  return null;
}

/**
 * For an existing session: the environment wins, then the stored pair, then the embedded one.
 * A session created with the embedded pair is never moved silently to a different one: Telegram
 * ties a session to its app, so a build embedding another pair (or none) refuses instead.
 */
export function resolveCredentials(
  context: BackendContext,
  store: SecretStore,
  embedded: TelegramCredentials | null = embeddedCredentials(),
): TelegramCredentials {
  refuseConfigCredentials(context.settings);
  const fromEnv = credentialsFromEnv(context.env);
  if (fromEnv) return fromEnv;
  const stored = readStoredCredentials(store);
  if (stored) {
    if (readStoredSource(store) === 'embedded' && (!embedded || !sameCredentials(stored, embedded))) {
      throw new Error(
        fmt(
          _(
            'this Telegram session was created with the API credentials embedded in the build that made it, ' +
              'and this build embeds {embeds} (values not shown) — use that build again, set {idEnv} and ' +
              '{hashEnv}, or log in again with `curlew accounts add telegram`',
          ),
          {
            // TRANSLATORS: Both fill {embeds} in the message above.
            embeds: embedded ? _('a different pair') : _('none'),
            idEnv: API_ID_ENV,
            hashEnv: API_HASH_ENV,
          },
        ),
      );
    }
    return stored;
  }
  if (embedded) return embedded;
  throw new Error(
    fmt(
      _(
        'this Telegram session has no api_id/api_hash stored — log in again with ' +
          '`curlew accounts add telegram`, or set {idEnv} and {hashEnv}',
      ),
      { idEnv: API_ID_ENV, hashEnv: API_HASH_ENV },
    ),
  );
}
