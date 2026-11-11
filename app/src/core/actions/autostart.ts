/**
 * "Keep receiving": whether the daemon starts with the session and runs without a window.
 *
 * Callers ask for the capability and never for a mechanism (ADR 0011): outside a sandbox that is a
 * systemd user unit, inside a Flatpak the Background portal (`lib/autostart-portal.ts`). A setup
 * step, a settings switch and an agent see the same three methods.
 */

import { _, fmt } from '@curlew/protocol';
import type { CommandRunner } from './setup-host.ts';
import { UNIT_NAME } from './setup-unit.ts';

/** `unknown` is a mechanism that cannot be asked (the portal has no query); it is not "off". */
export type AutostartState = 'enabled' | 'disabled' | 'unknown';

export type AutostartResult = { ok: true } | { ok: false; reason: string };

export interface Autostart {
  /** Whether this driver runs a unit file that `curlew setup` has to write first. */
  readonly needsUnitFile: boolean;
  status(): Promise<AutostartState>;
  /** Start the daemon with the session, and now. */
  enable(): Promise<AutostartResult>;
  disable(): Promise<AutostartResult>;
}

/** The Linux driver outside a sandbox: the user unit that `curlew setup` writes. */
export function systemdAutostart(host: CommandRunner): Autostart {
  const systemctl = (...args: string[]) => host.run(['systemctl', '--user', ...args]);
  const failed = (verb: string, code: number): AutostartResult => ({
    ok: false,
    reason: fmt(_('systemctl --user {verb} exited {code}'), { verb, code }),
  });
  return {
    needsUnitFile: true,
    status: async () => (systemctl('is-enabled', UNIT_NAME).code === 0 ? 'enabled' : 'disabled'),
    enable: async () => {
      systemctl('daemon-reload');
      const result = systemctl('enable', '--now', UNIT_NAME);
      return result.code === 0 ? { ok: true } : failed('enable --now', result.code);
    },
    disable: async () => {
      const result = systemctl('disable', '--now', UNIT_NAME);
      return result.code === 0 ? { ok: true } : failed('disable --now', result.code);
    },
  };
}
