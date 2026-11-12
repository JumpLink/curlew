/**
 * Contact actions — Evolution Data Server address books (CardDAV/local).
 */

import { searchContacts } from '@curlew/gnome';
import type { ContactDTO, SearchContactsOptions } from '@curlew/protocol';
import { demoActive } from '../demo/active.ts';
import { capLimit, CONTACT_LIMIT } from './limits.ts';

/** Search contacts; caps the result count so a caller can't dump a whole address book. */
export async function contactsSearch(options: SearchContactsOptions = {}): Promise<ContactDTO[]> {
  return searchContacts({ ...options, limit: capLimit(options.limit, CONTACT_LIMIT) });
}

/** What the window's contact picker asks: a person scrolling a list, not an agent, so a larger cap. */
const PICKER_LIMIT = 1000;

export async function contactsForPicker(query = ''): Promise<ContactDTO[]> {
  if (demoActive()) return [];
  return searchContacts({ query, limit: PICKER_LIMIT });
}
