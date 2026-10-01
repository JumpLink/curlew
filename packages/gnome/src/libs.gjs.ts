/**
 * The optional typelibs, loaded on first use (see optional.ts for why).
 *
 * `import()` of a `gi://` URL is a plain dynamic import: GJS resolves it at runtime and the
 * gjsify bundler leaves it alone, so a missing typelib is a catchable rejection. Verified
 * on macOS (no EDS/GOA) with a probe bundle; `imports.gi` behaves the same but is untyped.
 */

import { optionalNamespace } from './optional.ts';

export const goa = optionalNamespace('Goa', async () => (await import('gi://Goa?version=1.0')).default);

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

/** ECal + ICalGLib, with the Promise overload of `get_object_list_as_comps` installed. */
export const cal = optionalNamespace('ECal', async () => {
  const [{ default: Gio }, { default: ECal }, { default: ICalGLib }] = await Promise.all([
    import('gi://Gio?version=2.0'),
    import('gi://ECal?version=2.0'),
    import('gi://ICalGLib?version=3.0'),
  ]);
  // get_object_list_as_comps has a Promise overload in the types; match the runtime.
  Gio._promisify(ECal.Client.prototype, 'get_object_list_as_comps', 'get_object_list_as_comps_finish');
  return { ECal, ICalGLib };
});
