/**
 * `curlew conversations` — the per-person view: mail threads and chats grouped into
 * conversations, with `--people-only` hiding newsletters, notifications and other machine mail.
 *
 * Offline: reads what `curlew sync` built. `classify` corrects a sender in the config file.
 */

import { _, fmt } from '@curlew/protocol';
import type { CommandModule } from 'yargs';

import {
  CONVERSATION_BODY_CHARS,
  CONVERSATION_LIMIT,
  conversationsClassify,
  conversationsList,
  conversationsShow,
} from '../../core/actions/index.ts';
import { pickArgv, runAndExit } from './output.ts';

const CLASSIFY_CHOICES = ['conversational', 'automated', 'auto'] as const;

export const conversationsCommand: CommandModule = {
  command: 'conversations',
  get describe() {
    return _('Conversations across mail threads and chats, from the local index (built by `curlew sync`)');
  },
  handler: () => {},
  builder: (yargs) =>
    yargs
      .demandCommand(1, _('Choose a subcommand: list, show, classify'))
      .command({
        command: 'list',
        describe: _('Conversations, newest first'),
        builder: (y) =>
          y
            .option('people-only', {
              type: 'boolean',
              describe: _('Only conversations with a person in them — no newsletters or notifications'),
            })
            .option('account', { type: 'string', describe: _('Restrict to one account id') })
            .option('limit', {
              type: 'number',
              describe: fmt(_('Max conversations (max {max})'), { max: CONVERSATION_LIMIT.max }),
            }),
        handler: (argv) => {
          const raw = argv as Record<string, unknown>;
          runAndExit(() =>
            Promise.resolve(
              conversationsList({
                peopleOnly: pickArgv<boolean>(raw, 'people-only', 'peopleOnly'),
                accountId: pickArgv<string>(raw, 'account'),
                limit: pickArgv<number>(raw, 'limit'),
              }),
            ),
          );
        },
      })
      .command({
        command: 'show <id>',
        describe: _('One conversation with its messages (bodies only with --bodies)'),
        builder: (y) =>
          y
            .positional('id', {
              type: 'string',
              demandOption: true,
              describe: _('Conversation id from `list`'),
            })
            .option('bodies', { type: 'boolean', describe: _('Include each message body from the index') })
            .option('since', { type: 'string', describe: _('Only messages sent after this ISO 8601 time') })
            .option('incoming-only', { type: 'boolean', describe: _('Only messages from the other side') })
            .option('max-body-chars', {
              type: 'number',
              describe: fmt(_('Per-message body cap (default {default}, max {max})'), {
                default: CONVERSATION_BODY_CHARS.default,
                max: CONVERSATION_BODY_CHARS.max,
              }),
            }),
        handler: (argv) => {
          const raw = argv as Record<string, unknown>;
          runAndExit(() =>
            Promise.resolve(
              conversationsShow({
                id: String(raw.id),
                includeBodies: pickArgv<boolean>(raw, 'bodies'),
                maxBodyChars: pickArgv<number>(raw, 'max-body-chars', 'maxBodyChars'),
                since: pickArgv<string>(raw, 'since'),
                incomingOnly: pickArgv<boolean>(raw, 'incoming-only', 'incomingOnly'),
              }),
            ),
          );
        },
      })
      .command({
        command: 'classify <address> <as>',
        describe: _('Correct how mail from one sender is classified (auto = back to the rules)'),
        builder: (y) =>
          y
            .positional('address', { type: 'string', demandOption: true, describe: _('Sender mail address') })
            .positional('as', { choices: CLASSIFY_CHOICES, demandOption: true }),
        handler: (argv) => {
          const raw = argv as Record<string, unknown>;
          runAndExit(() =>
            Promise.resolve(
              conversationsClassify(String(raw.address), raw.as as (typeof CLASSIFY_CHOICES)[number]),
            ),
          );
        },
      }),
};
