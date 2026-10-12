/**
 * `curlew accounts` — the configured GNOME Online Accounts, a backend's own accounts, and the
 * interactive login for backends that keep their own (Telegram).
 *
 * The account ids printed here are the join key for every other command: `--account`.
 */

import type { CommandModule } from 'yargs';

import { accountsAdd, accountsList, backendAccountsList } from '../../core/actions/index.ts';
import { pickArgv, runAndExit } from './output.ts';
import { terminalPrompter } from './prompt.ts';

export const accountsCommand: CommandModule = {
  command: 'accounts',
  describe: 'List accounts (GNOME Online Accounts by default) or log in to a chat backend',
  builder: (yargs) =>
    yargs
      .command({
        command: 'list',
        describe: 'List GNOME Online Accounts, or with --backend the accounts of one backend',
        builder: (y) =>
          y.option('backend', {
            type: 'string',
            describe: 'A backend that keeps its own accounts, e.g. telegram',
          }),
        handler: (argv) => {
          const backend = pickArgv<string>(argv as Record<string, unknown>, 'backend');
          runAndExit<unknown>(() => (backend ? backendAccountsList(backend) : accountsList()));
        },
      })
      .command({
        command: 'add <backend>',
        describe: 'Log in to a chat backend interactively and keep the session (0600, never in the repo)',
        builder: (y) =>
          y
            .positional('backend', { type: 'string', demandOption: true, describe: 'e.g. telegram' })
            .option('own-credentials', {
              type: 'boolean',
              default: false,
              describe: 'Telegram: ask for your own api_id/api_hash even if this build embeds a pair',
            }),
        handler: (argv) => {
          const backend = String((argv as Record<string, unknown>).backend);
          const ownCredentials =
            pickArgv<boolean>(argv as Record<string, unknown>, 'ownCredentials', 'own-credentials') === true;
          runAndExit(async () => {
            const prompter = terminalPrompter();
            try {
              return await accountsAdd(backend, prompter, { ownCredentials });
            } finally {
              prompter.close();
            }
          });
        },
      }),
  handler: () => {
    runAndExit(() => accountsList());
  },
};
