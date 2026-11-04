/**
 * Reads and writes the agent-access rules for the window — through `loadConfig` and `saveConfig`
 * and nothing else, so the file keeps the shape, the mode (0600) and the atomic rename every other
 * writer uses, and no key but `agentAccess` is touched.
 *
 * An edit is applied to the file AS IT IS NOW: `updateAgentAccess` reads it again right before it
 * saves, so a rule the daemon added from an "Always" answer while the window was open is kept. The
 * window between that read and the rename is a few milliseconds; a write landing in it still wins
 * or loses as a whole, as it does between any two curlew writers — there is no file lock.
 */

import { configPath } from '@curlew/store';

import type { AgentAccessPolicy } from '../core/agent-access.ts';
import { loadConfig, saveConfig } from '../core/config.ts';
import type { EditResult, PolicyEdit } from './agent-access-model.ts';

export interface AgentAccessState {
  policy: AgentAccessPolicy;
  /** Names of the backends the config enables; the window asks each for its accounts. */
  backends: string[];
}

export function loadAgentAccess(path = configPath()): AgentAccessState {
  const config = loadConfig(path);
  return {
    policy: config.agentAccess,
    backends: Object.entries(config.backends)
      .filter(([, backend]) => backend.enabled)
      .map(([name]) => name),
  };
}

/** Apply one edit to the file as it is now. Nothing is written when the edit is refused. */
export function updateAgentAccess(edit: PolicyEdit, path = configPath()): EditResult {
  const config = loadConfig(path);
  const result = edit(config.agentAccess);
  if (!result.ok) return result;
  saveConfig({ ...config, agentAccess: result.policy }, path);
  return result;
}
