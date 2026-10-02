/**
 * @postbote/gnome entry — one implementation for every runtime.
 *
 * Native implementation over `gi://Goa`, `gi://EDataServer`, `gi://EBook`, `gi://ECal`, …
 * returning the plain DTOs from @postbote/protocol. It runs unchanged on GJS (native `gi://`)
 * and on Node/Bun, where `gi://` resolves through `@gjsify/node-gi` with GJS semantics. What it
 * needs is a GNOME session with GOA/EDS running, not a particular JS runtime.
 *
 * The GOA/EDS typelibs are OPTIONAL and load on first use (`libs.gjs.ts`, `optional.ts`), on
 * both runtimes: a host without them still starts, and the first call that needs one rejects
 * with `GnomeUnavailableError`. `check()` reports it instead of throwing.
 */

export { check, describeUnavailable, listAccounts } from './goa.gjs.ts';
export { searchContacts } from './contacts.gjs.ts';
export { listEvents } from './calendar.gjs.ts';
export { listMailTargets } from './credentials.gjs.ts';
