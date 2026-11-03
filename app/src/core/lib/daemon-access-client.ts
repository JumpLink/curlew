/**
 * The caller's side of the daemon's prompt service. Until the daemon serves one, nobody can be
 * asked: every request is "no daemon", which the enforcement turns into a refusal that says so.
 */

import type { AccessPort } from '../access.ts';

export function gioAccessClient(): AccessPort {
  return { request: async () => null };
}
