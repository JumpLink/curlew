/**
 * libsignal, loaded on demand.
 *
 * `@signalapp/libsignal-client` is Rust behind N-API: loading it maps a native library into the
 * process. curlew's CLI bundle carries every backend, so a static import would load the addon
 * on every start — and fail every start on a platform without a prebuild, Signal enabled or not.
 * So nothing in this package imports it at module level: the backend loads it the first time it
 * is used, and hands it to the code that needs it (`SignalLib`). A test passes the module in.
 */

import { readdirSync } from 'node:fs';
import { _, fmt } from '@curlew/protocol';
import type * as Core from '@signalapp/libsignal-client';
import type * as Zk from '@signalapp/libsignal-client/dist/zkgroup/index.js';

export interface SignalLib {
  core: typeof Core;
  zk: typeof Zk;
}

/** True on a musl system (an `ld-musl-*` loader in /lib), where libsignal's glibc prebuild needs gcompat. */
export function isMusl(): boolean {
  try {
    return readdirSync('/lib').some((f) => f.startsWith('ld-musl-'));
  } catch {
    return false;
  }
}

/** The user-facing reason libsignal did not load; names gcompat on musl. */
export function loadFailureReason(cause: string, musl: boolean): string {
  return musl
    ? fmt(_('Signal needs gcompat on this system; install it and the Curlew glibc shim ({reason})'), {
        reason: cause,
      })
    : fmt(_("Signal needs libsignal's native addon, which did not load on this platform ({reason})"), {
        reason: cause,
      });
}

let loading: Promise<SignalLib> | null = null;

/** Load libsignal once. Rejects with a readable error where no prebuild runs. */
export function loadSignalLib(): Promise<SignalLib> {
  loading ??= (async () => {
    try {
      const [core, zk] = await Promise.all([
        import('@signalapp/libsignal-client'),
        import('@signalapp/libsignal-client/dist/zkgroup/index.js'),
      ]);
      return { core, zk };
    } catch (err) {
      loading = null;
      throw new Error(loadFailureReason(err instanceof Error ? err.message : String(err), isMusl()));
    }
  })();
  return loading;
}
