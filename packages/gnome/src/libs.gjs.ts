/**
 * The optional typelibs, loaded on first use (see optional.ts for why).
 *
 * `import()` of a `gi://` URL is a plain dynamic import: GJS resolves it at runtime and the
 * gjsify bundler leaves it alone, so a missing typelib is a catchable rejection. Verified
 * on macOS (no EDS/GOA) with a probe bundle; `imports.gi` behaves the same but is untyped.
 */

import { optionalNamespace } from './optional.ts';

export const eds = optionalNamespace('EDataServer', async () => (await import('gi://EDataServer?version=1.2')).default);

/** EBook + the contacts types it needs, with the Promise overload of `get_contacts` installed. */
export const book = optionalNamespace('EBook', async () => {
  const [{ default: Gio }, { default: EBook }, { default: EBookContacts }] = await Promise.all([
    import('gi://Gio?version=2.0'),
    import('gi://EBook?version=1.2'),
    import('gi://EBookContacts?version=1.2'),
  ]);
  // get_contacts has a Promise overload in the types; make the runtime match.
  Gio._promisify(EBook.BookClient.prototype, 'get_contacts', 'get_contacts_finish');
  return { EBook, EBookContacts };
});

/** ICalGLib, to read the iCalendar text `@gjsify/pim` hands out. */
export const ical = optionalNamespace('ICalGLib', async () => (await import('gi://ICalGLib?version=3.0')).default);
