/**
 * What the Background portal is asked and how its answer reads. Pure: no libportal, no bus, so the
 * rules are tested on Node and GJS alike (the `gi://Xdp` part is `autostart-portal.ts`).
 *
 * The portal treats every request as the complete wish: a request WITHOUT the autostart flag removes
 * the autostart entry. So each request says whether autostart is wanted, never just "background".
 */

import { _ } from '@curlew/protocol';
import type { AutostartResult } from '../actions/autostart.ts';

export interface BackgroundRequest {
  /** The command the portal starts at login; `null` when autostart is not wanted. */
  commandline: string[] | null;
  autostart: boolean;
}

export function backgroundRequest(autostart: boolean, commandline: readonly string[]): BackgroundRequest {
  return { autostart, commandline: autostart ? [...commandline] : null };
}

/**
 * `granted` is libportal's answer to "may the app run in the background". For `enable` that is the
 * answer. For `disable` the entry is gone either way: a refused background permission is not a failure
 * to switch autostart off.
 */
export function backgroundResult(granted: boolean, autostart: boolean): AutostartResult {
  if (granted || !autostart) return { ok: true };
  return { ok: false, reason: _('declined in the permission dialog') };
}

/** A missing typelib, no portal or a call that errored: one clear reason, never a crash. */
export function unavailableResult(): AutostartResult {
  return { ok: false, reason: _('no Background portal on this system') };
}
