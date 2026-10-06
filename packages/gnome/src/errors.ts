import GLib from 'gi://GLib?version=2.0';

import { errorMessage, GnomeError, GnomeUnavailableError } from '@curlew/protocol';

/**
 * Build a GnomeError from a native failure, keeping the GError metadata.
 *
 * `GnomeError.domain` / `.code` existed with nothing setting them, so every error this
 * package raised carried `undefined` in two fields named after a GError — a reader would
 * reasonably branch on them and get `undefined`. They are set here, at the boundaries that
 * hold the native cause.
 *
 * The two runtimes disagree about what `err.domain` IS, measured on one GOA failure:
 *
 *   gjs        domain = 198                                  (a quark number)
 *   node-gi    domain = "g-io-error-quark", domainQuark = 198
 *
 * so the field is normalised to the quark's NAME and `code` to the numeric code, which then
 * mean the same thing on both. That is not decoration: `Gio.IOErrorEnum.CANCELLED` (19) is
 * what the 5s connect timeout produces, and it is the only way for a caller to tell "we gave
 * up waiting" from "GOA said no" without matching the message.
 */
export function gnomeError(message: string, cause?: unknown): GnomeError {
  const source = cause as { domain?: unknown; domainQuark?: unknown; code?: unknown } | undefined;
  let domain: string | undefined;
  let code: number | undefined;

  if (typeof source?.domain === 'string') {
    domain = source.domain;
  } else if (typeof source?.domain === 'number') {
    domain = GLib.quark_to_string(source.domain) ?? undefined;
  } else if (typeof source?.domainQuark === 'number') {
    domain = GLib.quark_to_string(source.domainQuark) ?? undefined;
  }
  if (typeof source?.code === 'number') code = source.code;

  return new GnomeError(cause === undefined ? message : `${message}: ${errorMessage(cause)}`, domain, code);
}

/**
 * The error a public entry point lets through unchanged: one that already names its cause.
 * A `GnomeUnavailableError` is the lazy typelib loader's answer (`optional.ts`) and must keep
 * its type, because the CLI and MCP layers branch on it; a `GnomeError` already carries the
 * call that failed.
 */
export function isGnomeFailure(err: unknown): err is GnomeError | GnomeUnavailableError {
  return err instanceof GnomeError || err instanceof GnomeUnavailableError;
}
