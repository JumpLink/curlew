/**
 * `curlew calendar` — list Evolution Data Server calendar events (CalDAV/local).
 */

import { _, fmt } from '@curlew/protocol';
import type { CommandModule } from 'yargs';

import { calendarListEvents, EVENT_LIMIT, EVENT_WINDOW_DAYS } from '../../core/actions/index.ts';
import { pickArgv, runAndExit } from './output.ts';

export const calendarCommand: CommandModule = {
  command: 'calendar',
  get describe() {
    return _('List calendar events in a date range (CalDAV/local)');
  },
  builder: (yargs) =>
    yargs
      .option('from', { type: 'string', describe: _('Window start YYYY-MM-DD (default: today)') })
      .option('to', {
        type: 'string',
        describe: fmt(_('Window end YYYY-MM-DD (default: +{days} days)'), { days: EVENT_WINDOW_DAYS }),
      })
      .option('limit', {
        type: 'number',
        describe: fmt(_('Max events (default {default}, max {max})'), {
          default: EVENT_LIMIT.default,
          max: EVENT_LIMIT.max,
        }),
      })
      .option('calendar', { type: 'string', describe: _('Restrict to a calendar source uid') })
      .option('account', { type: 'string', describe: _('Restrict to a GOA account id (from "accounts")') }),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    runAndExit(() =>
      calendarListEvents({
        from: pickArgv<string>(raw, 'from'),
        to: pickArgv<string>(raw, 'to'),
        limit: pickArgv<number>(raw, 'limit'),
        calendarUid: pickArgv<string>(raw, 'calendar'),
        accountId: pickArgv<string>(raw, 'account'),
      }),
    );
  },
};
