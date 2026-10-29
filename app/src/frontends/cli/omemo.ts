/**
 * `curlew omemo` — the end-to-end encryption keys of one XMPP account.
 *
 * Reads the account's secret file; it never connects and never publishes. The fingerprints it
 * prints are what a person compares out of band before deciding to trust a device (ADR 0006 §6).
 *
 * `trust` and `reset` are the only writers in curlew's OMEMO, and they live HERE rather than
 * beside the read-only MCP tool on purpose: both need an interactive terminal, and `trust` needs
 * the fingerprint typed back. That is a speed bump against an agent with a shell, not a
 * boundary — the boundary is that no grant and no MCP tool exist for either (§6).
 */

import { _ } from '@curlew/protocol';
import type { CommandModule } from 'yargs';

import {
  omemoDevices,
  omemoReset,
  omemoTrust,
  requireRetypedFingerprint,
} from '../../core/actions/index.ts';
import { pickArgv, runAndExit } from './output.ts';
import { readPrompter, stdinIsTTY } from './prompt.ts';

const accountOption = {
  type: 'string',
  demandOption: true,
  get describe() {
    return _('The xmpp account id, as `curlew accounts list --backend xmpp` shows it');
  },
} as const;

/** Ask for the fingerprint again at the terminal and hand back what was typed, or throw. */
async function retypeFingerprint(expected: string): Promise<string> {
  if (!stdinIsTTY()) {
    throw new Error(
      _('changing a trust decision needs an interactive terminal: run `curlew omemo trust` yourself'),
    );
  }
  const prompter = readPrompter();
  try {
    return requireRetypedFingerprint(expected, await prompter.ask(_('Type the fingerprint back')));
  } finally {
    prompter.close();
  }
}

export const omemoCommand: CommandModule = {
  command: 'omemo',
  // A getter for the same reason as `accountsCommand`: this object is built before `initI18n()`.
  get describe() {
    return _('Show and decide the OMEMO device keys of an XMPP account (never connects)');
  },
  builder: (yargs) =>
    yargs
      .demandCommand(1, _('Choose a subcommand: devices, trust, reset'))
      .command({
        command: 'devices',
        describe: _('Every device key this account knows, with its fingerprint and trust'),
        builder: (y) =>
          y.option('account', accountOption).option('jid', {
            type: 'string',
            describe: _('Only this contact; every known address when left out'),
          }),
        handler: (argv) => {
          const raw = argv as Record<string, unknown>;
          const jid = pickArgv<string>(raw, 'jid');
          runAndExit(() =>
            omemoDevices({ accountId: String(raw.account), ...(jid === undefined ? {} : { jid }) }),
          );
        },
      })
      .command({
        command: 'trust',
        describe: _('Decide one device key after comparing its fingerprint out of band'),
        builder: (y) =>
          y
            .option('account', accountOption)
            .option('jid', {
              type: 'string',
              demandOption: true,
              describe: _('The contact whose device key this is'),
            })
            .option('fingerprint', {
              type: 'string',
              demandOption: true,
              describe: _('The fingerprint `curlew omemo devices` printed, in any grouping'),
            })
            .option('state', {
              type: 'string',
              demandOption: true,
              choices: ['verified', 'distrusted'] as const,
              describe: _('`verified` after comparing it with them, `distrusted` to never encrypt to it'),
            }),
        handler: (argv) => {
          const raw = argv as Record<string, unknown>;
          runAndExit(async () => {
            const typed = await retypeFingerprint(String(raw.fingerprint));
            return omemoTrust({
              accountId: String(raw.account),
              jid: String(raw.jid),
              fingerprint: typed,
              state: raw.state === 'distrusted' ? 'distrusted' : 'verified',
            });
          });
        },
      })
      .command({
        command: 'reset',
        describe: _('Throw away the sessions with one contact; their keys and your decisions stay'),
        builder: (y) =>
          y.option('account', accountOption).option('jid', {
            type: 'string',
            demandOption: true,
            describe: _('The contact whose sessions are stuck'),
          }),
        handler: (argv) => {
          const raw = argv as Record<string, unknown>;
          runAndExit(async () => {
            // A terminal, but no retype: a reset forgets no decision and reveals nothing, so the
            // only thing worth stopping is an agent doing it unprompted (§6).
            if (!stdinIsTTY()) {
              throw new Error(
                _('resetting sessions needs an interactive terminal: run `curlew omemo reset` yourself'),
              );
            }
            return omemoReset({ accountId: String(raw.account), jid: String(raw.jid) });
          });
        },
      }),
  handler: () => {},
};
