/**
 * Lazy, cached access to the OPTIONAL GObject-Introspection namespaces (Goa, EDataServer, EBook,
 * ECal, …). Pure — the `gi://` import lives in the caller's loader thunk — so the degradation
 * is testable on Node.
 *
 * Why not a static `import 'gi://EBook'`: a missing typelib throws at module load and takes the
 * whole app down with it (macOS has neither GOA nor Evolution Data Server), including mail and
 * the chat backends that never touch them. Loading on first use turns that into a
 * `GnomeUnavailableError` the caller already knows how to report.
 */

import { errorMessage, GnomeUnavailableError } from '@curlew/protocol';

export interface OptionalNamespace<T> {
  /** The loaded namespace; throws `GnomeUnavailableError` when it cannot be loaded. */
  get(): Promise<T>;
}

/**
 * Wrap a loader so it runs at most once. A failure is cached too: a typelib that is missing now
 * stays missing for the life of the process, and retrying would only repeat the lookup.
 */
export function optionalNamespace<T>(label: string, load: () => Promise<T>): OptionalNamespace<T> {
  let pending: Promise<T> | null = null;
  return {
    get() {
      pending ??= load().catch((err: unknown) => {
        throw new GnomeUnavailableError(`${label} typelib not available: ${errorMessage(err)}`);
      });
      return pending;
    },
  };
}

const OPTIONAL_GI_WARNING = /^optional GI namespace /;

/**
 * Run `load` while holding back the bundler's "optional GI namespace … is not available" warning.
 *
 * The shim warns at module evaluation, before anyone knows whether the missing typelib matters.
 * `release(true)` demotes the held lines to debug (another route answered, as the D-Bus driver
 * does in a Flatpak); `release(false)` prints them as the warnings they were. Other warnings pass
 * through untouched.
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
