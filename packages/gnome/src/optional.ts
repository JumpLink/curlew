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
