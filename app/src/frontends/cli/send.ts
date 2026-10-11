/**
 * `curlew send` — one plain-text chat message from a granted XMPP account (ADR 0004 §4).
 *
 * The same grant the MCP tool checks: `xmpp.send` with target `<account>/<address>`. Without it
 * the command refuses and writes nothing.
 */

import type { CommandModule } from 'yargs';

import { sendMessage } from '../../core/actions/index.ts';
import { runAndExit } from './output.ts';

export const sendCommand: CommandModule = {
  command: 'send <text>',
  describe: 'Send a chat message from a granted XMPP account (needs an xmpp.send grant in the config)',
  builder: (yargs) =>
    yargs
      .positional('text', { type: 'string', demandOption: true, describe: 'The message, plain text' })
      .option('account', { type: 'string', demandOption: true, describe: 'XMPP account id (xmpp-…)' })
      .option('to', {
        type: 'string',
        demandOption: true,
        describe: 'Bare address exactly as the grant spells it (name@example.org)',
      }),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    runAndExit(() =>
      sendMessage({
        accountId: String(raw.account),
        to: String(raw.to),
        text: String(raw.text),
        frontend: 'cli',
      }),
    );
  },
};
