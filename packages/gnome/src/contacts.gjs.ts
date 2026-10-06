/**
 * Contacts via Evolution Data Server.
 *
 * Reads CardDAV/local address books that EDS exposes (a Nextcloud GOA account
 * yields a CardDAV book here). Returns plain ContactDTOs projected from the
 * vCard attributes — never EContact/GObject instances. Runs unchanged on GJS
 * and on Node/Bun via `@gjsify/node-gi` — see `index.ts`.
 */

import type EBook from 'gi://EBook?version=1.2';
import type EBookContacts from 'gi://EBookContacts?version=1.2';
import type EDataServer from 'gi://EDataServer?version=1.2';

import { extractList, getRegistry, sourceGoaAccountId } from './eds.gjs.ts';
import { gnomeError, isGnomeFailure } from './errors.ts';
import { book, eds } from './libs.gjs.ts';
import type { ContactDTO, SearchContactsOptions } from '@curlew/protocol';

const DEFAULT_LIMIT = 50;
/** Seconds BookClient.connect waits for the backend to be connected. */
const CONNECT_WAIT_SECONDS = 15;

/** Promise wrapper around the static async BookClient.connect (callback-only in @girs). */
function connectBook(lib: typeof EBook, source: EDataServer.Source): Promise<EBook.BookClient> {
  return new Promise((resolve, reject) => {
    lib.BookClient.connect(source, CONNECT_WAIT_SECONDS, null, (_src, res) => {
      try {
        resolve(lib.BookClient.connect_finish(res));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function attrValue(attr: EBookContacts.VCardAttribute): string | null {
  const v = attr.get_value();
  return v && v.length > 0 ? v : null;
}

/** Project an EContact's vCard attributes into a plain DTO. */
function mapContact(contact: EBookContacts.Contact): ContactDTO {
  let name = '';
  let org: string | null = null;
  let uid = '';
  const emails: string[] = [];
  const phones: string[] = [];
  const jids: string[] = [];
  for (const attr of contact.get_attributes()) {
    switch (attr.get_name().toUpperCase()) {
      case 'FN':
        name = attrValue(attr) ?? name;
        break;
      case 'ORG':
        org = attrValue(attr) ?? org;
        break;
      case 'EMAIL': {
        const v = attrValue(attr);
        if (v) emails.push(v);
        break;
      }
      case 'TEL': {
        const v = attrValue(attr);
        if (v) phones.push(v);
        break;
      }
      // Evolution writes X-JABBER; vCard 4 and most CardDAV servers write IMPP with a scheme.
      case 'X-JABBER': {
        const v = attrValue(attr);
        if (v) jids.push(v);
        break;
      }
      case 'IMPP': {
        const v = attrValue(attr);
        if (v && /^xmpp:/i.test(v)) jids.push(v);
        break;
      }
      case 'UID':
        uid = attrValue(attr) ?? uid;
        break;
    }
  }
  return { uid, name, org, emails, phones, ...(jids.length > 0 ? { jids } : {}) };
}

/** Do the work. Everything here may raise a native error; `searchContacts` owns the boundary. */
async function searchContactsImpl(options: SearchContactsOptions): Promise<ContactDTO[]> {
  const { query, limit = DEFAULT_LIMIT, accountId } = options;
  const { EBook: ebook, EBookContacts: contactsLib } = await book.get();
  const EDS = await eds.get();
  const reg = await getRegistry();

  let sources: EDataServer.Source[];
  try {
    sources = reg.list_enabled(EDS.SOURCE_EXTENSION_ADDRESS_BOOK);
  } catch (err) {
    throw gnomeError('list address books', err);
  }
  if (accountId) {
    sources = sources.filter((s) => sourceGoaAccountId(EDS, reg, s) === accountId);
  }

  const sexp = contactsLib.BookQuery.any_field_contains(query ?? '').to_string();
  const results: ContactDTO[] = [];
  let opened = 0;
  let lastError: unknown = null;

  for (const source of sources) {
    if (results.length >= limit) break;
    let client: EBook.BookClient;
    try {
      client = await connectBook(ebook, source);
      opened++;
    } catch (err) {
      lastError = err;
      continue;
    }
    try {
      const contacts = extractList<EBookContacts.Contact>(await client.get_contacts(sexp, null));
      for (const contact of contacts) {
        results.push(mapContact(contact));
        if (results.length >= limit) break;
      }
    } catch (err) {
      throw gnomeError(`get_contacts(${source.get_display_name()})`, err);
    }
  }

  if (opened === 0 && sources.length > 0 && lastError) {
    throw gnomeError('connect address book', lastError);
  }
  return results;
}

/**
 * Search contacts across enabled address books (optionally restricted to one
 * GOA account). Empty query matches all (subject to limit). Address books that
 * fail to open are skipped; if none open, the last error is surfaced.
 *
 * This is the boundary for the whole EDS contacts path. Every `gi://` property read it
 * makes — `BookQuery.any_field_contains()`, `getRegistry()`, `source.get_display_name()` —
 * raises on its own, and on GJS a GLib.Error is a boxed GObject that is not `instanceof Error`
 * and JSON-serializes to `{}`: unwrapped, `curlew contacts` reports nothing at all. Only a
 * call that is already a `GnomeError` / `GnomeUnavailableError` passes through unchanged, so
 * the specific `list address books:` / `connect address book:` prefixes survive.
 */
export async function searchContacts(options: SearchContactsOptions): Promise<ContactDTO[]> {
  try {
    return await searchContactsImpl(options);
  } catch (err) {
    if (isGnomeFailure(err)) throw err;
    throw gnomeError('searchContacts', err);
  }
}
