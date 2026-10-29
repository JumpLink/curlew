/**
 * `curlew sync` and `curlew index` — building and inspecting the local index.
 *
 * Kept apart from `search` on purpose: only `sync` ever writes to the index, so a search can
 * never surprise anyone with disk growth. One mental model, stated in one place.
 */

import { _, fmt } from '@curlew/protocol';
import type { CommandModule } from 'yargs';

import type { SyncProgress } from '@curlew/store';
import type { IndexSyncResult } from '../../core/actions/index.ts';
import { indexSearch, indexStatus, indexSync } from '../../core/actions/index.ts';
import { MAIL_LIMIT, capLimit } from '../../core/actions/index.ts';
import { pickArgv, runAndExit } from './output.ts';

/**
 * One rewriting line on stderr: what is happening, how far, and what it has found so far.
 *
 * Counts and mailbox names only. The index holds other people's words and a progress line is a
 * log line that gets copied around (ADR 0002 §6), so nothing read out of a message goes here.
 */
function reportProgress(event: SyncProgress): void {
  const line =
    event.type === 'folder-done'
      ? `  mail ${event.done}/${event.folders} ${event.folderName} · ${event.added} new`
      : event.type === 'account-start'
        ? `  mail: ${event.accounts} account(s), this one has ${event.folders} mailbox(es)`
        : `  mail done: ${event.folders} mailbox(es), ${event.added} new, ${event.errors} error(s)`;
  // \r plus an erase: overwrite in place, and never leave the longer line's tail behind.
  process.stderr.write(`\r\u001b[2K${line}`);
  if (event.type !== 'folder-done') process.stderr.write('\n');
}

/**
 * One line per account a network told us to wait for — `telegram: rate limited, retry in 42s`.
 *
 * On stderr, so the JSON document on stdout stays parseable by a script. A backend name and a
 * wait only, never the network's own text: that can quote a chat.
 */
function reportRateLimits(result: IndexSyncResult): void {
  for (const chat of result.chats) {
    for (const account of chat.accounts) {
      if (!account.rateLimited) continue;
      const seconds = Math.ceil(account.rateLimited.retryAfterMs / 1000);
      process.stderr.write(`  ${chat.backend}: rate limited, retry in ${seconds}s\n`);
    }
  }
}

export const syncCommand: CommandModule = {
  command: 'sync',
  get describe() {
    return _('Build or update the local full-text index (the only command that writes to it)');
  },
  builder: (yargs) =>
    yargs
      .option('account', {
        type: 'string',
        describe: _('Restrict to one account id (GOA, or e.g. telegram-…); omit for all'),
      })
      .option('folder', {
        type: 'string',
        describe: _('Restrict to one mailbox (skips chat backends); omit for all'),
      })
      .option('full-scan', {
        type: 'boolean',
        describe: _(
          'Mail: force the flag/expunge pass. Chats: re-fetch the newest window, picking up edits and removing what was deleted',
        ),
      }),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    runAndExit(async () => {
      const result = await indexSync({
        accountId: pickArgv<string>(raw, 'account'),
        folder: pickArgv<string>(raw, 'folder'),
        fullScan: pickArgv<boolean>(raw, 'full-scan', 'fullScan'),
        // On stderr, so the result on stdout stays a JSON document a script can read. A sync of
        // several accounts and dozens of mailboxes takes minutes; showing nothing for minutes is
        // indistinguishable from a hang. One rewriting line, so the output does not scroll away.
        onProgress: reportProgress,
      });
      reportRateLimits(result);
      return result;
    });
  },
};

export const indexCommand: CommandModule = {
  command: 'index',
  get describe() {
    return _('Inspect or query the local index without touching the network');
  },
  handler: () => {},
  builder: (yargs) =>
    yargs
      .demandCommand(1, _('Choose a subcommand: status, search'))
      .command({
        command: 'status',
        describe: _('What the index holds, and which folders are stale'),
        handler: () => {
          runAndExit(() => Promise.resolve(indexStatus()));
        },
      })
      .command({
        command: 'search [query]',
        describe: _('Search the index only — offline, no server contact'),
        builder: (y) =>
          y
            .positional('query', { type: 'string', describe: _('Full text across subject, sender and body') })
            .option('from', { type: 'string', describe: _('Sender contains') })
            .option('subject', { type: 'string', describe: _('Subject contains') })
            .option('since', { type: 'string', describe: _('Date header on/after YYYY-MM-DD') })
            .option('before', { type: 'string', describe: _('Date header before YYYY-MM-DD') })
            .option('unseen', { type: 'boolean', describe: _('Only unseen messages') })
            .option('flagged', { type: 'boolean', describe: _('Only flagged messages') })
            .option('attachments', { type: 'boolean', describe: _('Only messages with an attachment') })
            .option('account', { type: 'string', describe: _('Restrict to a GOA account id') })
            .option('folder', { type: 'string', describe: _('Restrict to one mailbox (wire path)') })
            .option('limit', {
              type: 'number',
              describe: fmt(_('Max messages (max {max})'), { max: MAIL_LIMIT.max }),
            }),
        handler: (argv) => {
          const raw = argv as Record<string, unknown>;
          runAndExit(() =>
            Promise.resolve(
              indexSearch({
                query: pickArgv<string>(raw, 'query'),
                from: pickArgv<string>(raw, 'from'),
                subject: pickArgv<string>(raw, 'subject'),
                since: pickArgv<string>(raw, 'since'),
                before: pickArgv<string>(raw, 'before'),
                unseen: pickArgv<boolean>(raw, 'unseen'),
                flagged: pickArgv<boolean>(raw, 'flagged'),
                hasAttachment: pickArgv<boolean>(raw, 'attachments'),
                accountId: pickArgv<string>(raw, 'account'),
                folderPath: pickArgv<string>(raw, 'folder'),
                limit: capLimit(pickArgv<number>(raw, 'limit'), MAIL_LIMIT),
              }),
            ),
          );
        },
      }),
};
