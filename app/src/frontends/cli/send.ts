/**
 * `curlew send` — one message from a granted account (ADR 0004 §4, amended 2026-10-30).
 *
 * The same grant the MCP tool checks: `<backend>.send` with target `<account>/<address>`, the
 * account picking the backend. Without it the command refuses and writes nothing.
 */

import { _ } from '@curlew/protocol';
import type { CommandModule } from 'yargs';

import { sendMessage } from '../../core/actions/index.ts';
import { runAndExit } from './output.ts';

export const sendCommand: CommandModule = {
  command: 'send [text]',
  get describe() {
    return _('Send a message from a granted account (needs a <backend>.send grant in the config)');
  },
  builder: (yargs) =>
    yargs
      .positional('text', {
        type: 'string',
        describe: _('The message, plain text (optional with --image-url)'),
      })
      .option('image-url', {
        type: 'string',
        describe: _('XMPP only: https URL of one image, sent as its own message after the text'),
      })
      .option('subject', {
        type: 'string',
        describe: _('Mail only: the subject line'),
      })
      .option('account', { type: 'string', demandOption: true, describe: _('Account id from `curlew accounts list`') })
      .option('to', {
        type: 'string',
        demandOption: true,
        describe: _('Address exactly as the grant spells it (name@example.org)'),
      }),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    runAndExit(() =>
      sendMessage({
        accountId: String(raw.account),
        to: String(raw.to),
        text: raw.text === undefined ? undefined : String(raw.text),
        subject: raw.subject === undefined ? undefined : String(raw.subject),
        imageUrl: raw['image-url'] === undefined ? undefined : String(raw['image-url']),
        frontend: 'cli',
      }),
    );
  },
};
