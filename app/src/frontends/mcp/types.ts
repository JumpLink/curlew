/**
 * The one MCP tool-result helper postbote keeps of its own.
 *
 * `mcpSuccess` and `mcpError` moved to `@gjsify/mcp` at 0.54.0 — same bodies, same signatures, and
 * the tool files import them from the package. `mcpErrorFrom` stays because it is POSTBOTE's: it
 * knows that a `GnomeError` has a better sentence than its message, and that sentence is the
 * whole point of the helper.
 *
 * Every tool still returns JSON as a single text block — one shape for both success and failure,
 * so a client never has to guess. Errors carry the message only: the underlying errors are
 * protocol and GOA failures whose stack traces contain hostnames and paths, and an MCP error
 * string ends up in a transcript.
 */

import { mcpError } from '@gjsify/mcp';
import { describeUnavailable } from '@curlew/gnome';
import { GnomeError } from '@curlew/protocol';

/**
 * Error response built from a caught value (the common catch handler).
 *
 * A `GnomeError` is routed through `describeUnavailable` so the answer leads with the same
 * stable sentence `postbote check` prints, not with the locale string a GLib error carries.
 * Before this, `contacts_search` on a host with no session bus answered
 * `{"error":"Goa.Client.new: Verbindungen ist gescheitert: …"}` while `check` on the same host
 * said `GNOME Online Accounts / Evolution Data Server unavailable (…)`: same condition, two
 * different answers, one of them unusable. A non-GNOME error is passed through untouched — this
 * module must not claim to explain backends it knows nothing about, which is exactly what the
 * package's generic `mcpErrorFrom` does.
 */
export function mcpErrorFrom(err: unknown) {
  if (err instanceof GnomeError) return mcpError(describeUnavailable(err));
  return mcpError(err instanceof Error ? err.message : String(err));
}
