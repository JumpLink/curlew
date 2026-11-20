/**
 * One shared, quiet load of the host's account store, for every package that asks for it.
 *
 * `@gjsify/system-accounts` carries a `&optional` Goa import that runs ONCE, in whichever loader
 * comes first, and warns when the typelib is missing: the normal state in a Flatpak, where the
 * D-Bus driver answers instead. So the load, the probe and the release of that warning live
 * here, once; a second copy would let the warning escape through the other path.
 *
 * Pure and dependency-free: the package is reached through the caller's `load` thunk and only
 * the two methods the probe needs are described structurally.
 */

/** The slice of `SystemAccounts` the probe asks. */
export interface ProbeableAccounts {
  capabilities(): { services: readonly unknown[] };
  getMailSettings(account: {
    id: string;
    provider: string;
    providerName: string;
    identity: string;
    label: string;
    services: never[];
  }): Promise<object>;
}

const OPTIONAL_GI_WARNING = /^optional GI namespace /;

/**
 * Run `load` while holding back the bundler's "optional GI namespace ... is not available"
 * warning. `release(true)` demotes the held lines to debug (another route answered);
 * `release(false)` prints them as the warnings they were. Other warnings pass through.
 */
export async function holdOptionalGiWarnings<T>(
  load: () => Promise<T>,
): Promise<{ value: T; release: (answered: boolean) => void }> {
  const held: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && OPTIONAL_GI_WARNING.test(args[0])) held.push(args);
    else original.apply(console, args);
  };
  let value: T;
  try {
    value = await load();
  } catch (err) {
    console.warn = original;
    for (const args of held) original.apply(console, args);
    throw err;
  }
  console.warn = original;
  return {
    value,
    release(answered) {
      for (const args of held) (answered ? console.debug : console.warn).apply(console, args);
      held.length = 0;
    },
  };
}

/**
 * Whether the store really answers. `capabilities()` only says what the driver could serve, and
 * `listAccounts()` answers an empty list for an unreachable bus as for an empty store, so the
 * one honest probe is a question about an account that cannot exist: `no-account-store` means
 * the daemon is out of reach, `unknown-account` means it answered.
 */
export async function probeAccountStore(accounts: ProbeableAccounts): Promise<boolean> {
  if (accounts.capabilities().services.length === 0) return false;
  const answer = await accounts.getMailSettings({
    id: 'curlew-probe',
    provider: '',
    providerName: '',
    identity: '',
    label: '',
    services: [],
  });
  return !('reason' in answer) || (answer as { reason?: unknown }).reason !== 'no-account-store';
}

let shared: Promise<ProbeableAccounts> | undefined;

/**
 * The host's account store, loaded once per process through `load`, probed, and the held
 * warning released as debug (answered) or warning (nothing answered). A failed load is not
 * cached, so a later call retries.
 */
export function sharedHostAccounts<T extends ProbeableAccounts>(load: () => Promise<T>): Promise<T> {
  const pending = (shared ??= loadQuietly(load));
  pending.catch(() => {
    if (shared === pending) shared = undefined;
  });
  return pending as Promise<T>;
}

async function loadQuietly<T extends ProbeableAccounts>(load: () => Promise<T>): Promise<T> {
  const { value, release } = await holdOptionalGiWarnings(load);
  let answered = false;
  try {
    answered = await probeAccountStore(value);
  } catch {
    // unreachable: the held warning is the honest one
  }
  release(answered);
  return value;
}

/** Forget the cached store. For tests. */
export function resetSharedHostAccounts(): void {
  shared = undefined;
}
