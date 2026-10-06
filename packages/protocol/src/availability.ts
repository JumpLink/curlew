/**
 * Shared availability messages for the GNOME-facing backends.
 *
 * Two different bindings, two different runtime requirements, each with its own message:
 *
 *   @curlew/gnome  — ONE implementation on every runtime (`gi://` under GJS,
 *                      `@gjsify/node-gi` under Node/Bun). The GOA/EDS typelibs load on first
 *                      use, so its only conditions are runtime ones, reported by `check()`:
 *                        typelib or session bus missing → GOA_UNAVAILABLE_MESSAGE (ok: false)
 *                        0 accounts                     → NO_ACCOUNTS_MESSAGE (ok: true)
 *                      The data functions raise `GnomeUnavailableError` for a missing typelib
 *                      and `GnomeError` for a native failure.
 *
 *   @curlew/imap   — still split: a real `*.gjs.ts` implementation and a Node stub, because
 *                      its transport is Gio TLS sockets. That one does need GJS, and says so:
 *                        Node → GJS_REQUIRED_MESSAGE (GnomeUnavailableError)
 */

export const GNOME_CLIENT_NAME = 'GNOME';

export const GJS_REQUIRED_MESSAGE =
  'The IMAP mail backend requires the GJS runtime (it speaks IMAP over Gio TLS sockets) — run the GJS build via `gjsify run`, not plain node. Accounts, contacts and calendar are unaffected: @curlew/gnome runs on Node too.';

export const GOA_UNAVAILABLE_MESSAGE =
  'GNOME Online Accounts / Evolution Data Server unavailable (Goa/EDS typelib or session D-Bus missing).';

export const NO_ACCOUNTS_MESSAGE = 'OK (0 accounts configured — add one in GNOME Settings → Online Accounts)';
