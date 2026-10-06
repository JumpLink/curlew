/**
 * `curlew deliveries` — the delivery-only backends (WhatsApp, Signal): deliveries curlew
 * received and could not turn into a message.
 *
 * `set-aside` is the listing, and it is a CLI command only. What it shows is enough to find a
 * message on the phone or to report a decoder bug, and not one byte more: the plaintext stays in
 * the backend's secret file. A tool of that kind has nothing to say to an agent, so there is no
 * MCP counterpart — see the action's header.
 */

import type { CommandModule } from 'yargs';

import { deliveriesSetAside } from '../../core/actions/index.ts';
import { pickArgv, runAndExit } from './output.ts';

export const deliveriesCommand: CommandModule = {
  command: 'deliveries',
  describe: 'What the delivery-only backends (WhatsApp, Signal) received that curlew could not map',
  handler: () => {},
  builder: (yargs) =>
    yargs.demandCommand(1, 'Choose a subcommand: set-aside').command({
      command: 'set-aside',
      describe: 'Plaintexts a backend kept because it could not read them: sender, time, reason, size',
      builder: (y) =>
        y.option('account', {
          type: 'string',
          describe: 'Restrict to one account id (e.g. signal-…); omit for all',
        }),
      handler: (argv) => {
        const raw = argv as Record<string, unknown>;
        runAndExit(() => deliveriesSetAside({ accountId: pickArgv<string>(raw, 'account') }));
      },
    }),
};
