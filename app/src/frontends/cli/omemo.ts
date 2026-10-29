/**
 * `curlew omemo` — the end-to-end encryption keys of one XMPP account.
 *
 * Reads the account's secret file; it never connects and never publishes. The fingerprints it
 * prints are what a person compares out of band before deciding to trust a device (ADR 0006 §6).
 */

import { _ } from '@curlew/protocol';
import type { CommandModule } from 'yargs';

import { omemoDevices } from '../../core/actions/index.ts';
import { pickArgv, runAndExit } from './output.ts';

export const omemoCommand: CommandModule = {
  command: 'omemo',
  // A getter for the same reason as `accountsCommand`: this object is built before `initI18n()`.
  get describe() {
    return _('Show the OMEMO device keys of an XMPP account (reads only, never connects)');
  },
  builder: (yargs) =>
    yargs.demandCommand(1, _('Choose a subcommand: devices')).command({
      command: 'devices',
      describe: _('Every device key this account knows, with its fingerprint and trust'),
      builder: (y) =>
        y
          .option('account', {
            type: 'string',
            demandOption: true,
            describe: _('The xmpp account id, as `curlew accounts list --backend xmpp` shows it'),
          })
          .option('jid', {
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
    }),
  handler: () => {},
};
