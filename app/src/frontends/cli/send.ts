/**
 * `curlew send` — a plain-text chat message and/or one image from a granted XMPP account (ADR 0004 §4).
 *
 * The same grant the MCP tool checks: `xmpp.send` with target `<account>/<address>`. Without it
 * the command refuses and writes nothing.
 */

import { _ } from '@curlew/protocol';
import type { CommandModule } from 'yargs';

import { sendMessage } from '../../core/actions/index.ts';
import { runAndExit } from './output.ts';

export const sendCommand: CommandModule = {
  command: 'send [text]',
  get describe() {
    return _('Send a chat message from a granted XMPP account (needs an xmpp.send grant in the config)');
  },
  builder: (yargs) =>
    yargs
      .positional('text', {
        type: 'string',
        describe: _('The message, plain text (optional with --image-url)'),
      })
      .option('image-url', {
        type: 'string',
        describe: _('https URL of one image, sent as its own message after the text'),
      })
      .option('account', { type: 'string', demandOption: true, describe: _('XMPP account id (xmpp-…)') })
      .option('to', {
        type: 'string',
        demandOption: true,
        describe: _('Bare address exactly as the grant spells it (name@example.org)'),
      }),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    runAndExit(() =>
      sendMessage({
        accountId: String(raw.account),
        to: String(raw.to),
        text: raw.text === undefined ? undefined : String(raw.text),
        imageUrl: raw['image-url'] === undefined ? undefined : String(raw['image-url']),
        frontend: 'cli',
      }),
    );
  },
};
