/**
 * `curlew check` — report which backends are reachable.
 *
 * Three-state probe ({ name, ok, message }) so a caller can tell "unavailable here" apart from
 * "broken": on Node the IMAP mail backend reports that GJS is required, the GNOME probe reports
 * whether a GNOME session is reachable, and with one they report the account count.
 */

import type { CommandModule } from 'yargs';
import { check as checkGnome } from '@curlew/gnome';
import { runtimeName } from '../../core/runtime.ts';
import { runAndExit } from './output.ts';

export interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

export async function runChecks(): Promise<{ checks: CheckResult[] }> {
  const runtime = runtimeName();
  // Not "is this GJS": the GNOME bindings run on both (gi:// via @gjsify/node-gi), the IMAP
  // mail transport does not. ok stays false on Node because that backend is still gated.
  const checks: CheckResult[] = [
    {
      name: 'runtime',
      ok: runtime === 'gjs',
      message:
        runtime === 'gjs'
          ? 'running on GJS'
          : 'running on Node — GNOME accounts, contacts and calendar work here (gi:// via @gjsify/node-gi); the IMAP mail backend needs GJS (Gio TLS sockets)',
    },
  ];

  // Never let one probe's failure hide the others: report it as a failed check, not a throw.
  try {
    checks.push(await checkGnome());
  } catch (err) {
    checks.push({
      name: 'GNOME',
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return { checks };
}

export const checkCommand: CommandModule = {
  command: 'check',
  describe: 'Check which backends are reachable (runtime, GNOME Online Accounts, IMAP, index)',
  handler: () => {
    runAndExit(runChecks);
  },
};
