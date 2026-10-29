/**
 * `curlew contacts` — search Evolution Data Server address books (CardDAV/local).
 */

import { _, fmt } from '@curlew/protocol';
import type { CommandModule } from 'yargs';

import { contactsSearch, CONTACT_LIMIT } from '../../core/actions/index.ts';
import { pickArgv, runAndExit } from './output.ts';

export const contactsCommand: CommandModule = {
  command: 'contacts',
  get describe() {
    return _('Search contacts across enabled address books (CardDAV/local)');
  },
  builder: (yargs) =>
    yargs
      .option('query', {
        type: 'string',
        alias: 'q',
        describe: _('Free-text search (any field contains); omit to list all'),
      })
      .option('limit', {
        type: 'number',
        describe: fmt(_('Max results (default {default}, max {max})'), {
          default: CONTACT_LIMIT.default,
          max: CONTACT_LIMIT.max,
        }),
      })
      .option('account', { type: 'string', describe: _('Restrict to a GOA account id (from "accounts")') }),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    runAndExit(() =>
      contactsSearch({
        query: pickArgv<string>(raw, 'query'),
        limit: pickArgv<number>(raw, 'limit'),
        accountId: pickArgv<string>(raw, 'account'),
      }),
    );
  },
};
