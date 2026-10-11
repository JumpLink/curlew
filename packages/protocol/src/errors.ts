/**
 * Error classes shared by the pure protocol layer: the GNOME bindings' failures and the one
 * failure a chat network itself can raise (a rate limit).
 *
 * Note: no TypeScript parameter properties — Node's --experimental-strip-types
 * does not support them (same constraint as @buchhaltung/eric).
 */

/** Thrown when a data function is called but GOA/EDS is not reachable. */
export class GnomeUnavailableError extends Error {
  readonly name = 'GnomeUnavailableError';

  constructor(message: string) {
    super(message);
  }
}

/** Wraps a native GError (GLib.Error) surfaced from a GOA/EDS call. */
export class GnomeError extends Error {
  readonly name = 'GnomeError';
  readonly domain?: string;
  readonly code?: number;

  constructor(message: string, domain?: string, code?: number) {
    super(message);
    this.domain = domain;
    this.code = code;
  }
}

/**
 * The network asked this account to wait before it is asked again — Telegram's `FLOOD_WAIT_X`,
 * an HTTP 429, a chat network's own back-off. A backend raises it AT THE SESSION BOUNDARY, so the
 * sync engine can tell "the network is throttling us" from "this chat is broken" and stop asking
 * THIS account while the others run on. `retryAfterMs` is how long the network said to wait.
 */
export class ChatRateLimitedError extends Error {
  readonly name = 'ChatRateLimitedError';
  /** How long the network asked to wait, in milliseconds. */
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number, message?: string) {
    super(message ?? `the network asked to wait ${Math.ceil(retryAfterMs / 1000)}s`);
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Narrow an unknown thrown value to `ChatRateLimitedError`. By `name`, not `instanceof`: the
 * value crosses a backend boundary, where a second copy of the class would make `instanceof`
 * answer false for an error that is one.
 */
export function isChatRateLimitedError(err: unknown): err is ChatRateLimitedError {
  return (
    err instanceof Error &&
    err.name === 'ChatRateLimitedError' &&
    typeof (err as ChatRateLimitedError).retryAfterMs === 'number'
  );
}

/**
 * Extract a human-readable message from a thrown GLib.Error / unknown. Shared by
 * the GJS modules (goa/eds/mail) so they surface native errors uniformly.
 */
export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
