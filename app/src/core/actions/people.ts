/**
 * Merging people by hand. A merge is a grouping the person makes in the list; it lives in the
 * config and nowhere else: the address book is not written, no message is rewritten, and an agent
 * has no tool that changes it (interactive use only, like switching an account off).
 */

import { configPath } from '@curlew/store';

import { loadConfig, saveConfig } from '../config.ts';

type Groups = ReadonlyArray<ReadonlyArray<string>>;

/** The groups with `ids` joined into one; a group that shares a person with them is absorbed. */
export function withMerge(groups: Groups, ids: readonly string[]): string[][] {
  const joined = new Set(ids);
  const rest: string[][] = [];
  for (const group of groups) {
    if (group.some((id) => joined.has(id))) for (const id of group) joined.add(id);
    else rest.push([...group]);
  }
  return joined.size < 2 ? rest : [...rest, [...joined].sort()];
}

/** The groups without any that holds one of `ids`: the whole merge is undone, never part of it. */
export function withoutMerge(groups: Groups, ids: readonly string[]): string[][] {
  const named = new Set(ids);
  return groups.filter((group) => !group.some((id) => named.has(id))).map((group) => [...group]);
}

export function peopleMerge(ids: readonly string[], path = configPath()): void {
  const config = loadConfig(path);
  config.mergedPeople = withMerge(config.mergedPeople, ids);
  saveConfig(config, path);
}

export function peopleUnmerge(ids: readonly string[], path = configPath()): void {
  const config = loadConfig(path);
  config.mergedPeople = withoutMerge(config.mergedPeople, ids);
  saveConfig(config, path);
}

/** Remember that the person skipped this set, so the assistant does not ask again. */
export function peopleDecline(ids: readonly string[], path = configPath()): void {
  const config = loadConfig(path);
  const key = [...ids].sort().join('\u0000');
  if (config.declinedMerges.some((set) => [...set].sort().join('\u0000') === key)) return;
  config.declinedMerges = [...config.declinedMerges, [...ids]];
  saveConfig(config, path);
}

/**
 * The backend a send to these participants is pinned to, or null. A pin binds the whole merged
 * group the participants belong to, whichever of its ids carries it; on a conflict the smallest
 * id wins, as in the list.
 */
export function pinFor(
  groups: Groups,
  pins: Readonly<Record<string, string>>,
  participantIds: readonly string[],
): string | null {
  const people = new Set(participantIds);
  for (const group of groups) if (group.some((id) => people.has(id))) for (const id of group) people.add(id);
  const pinned = [...people].sort().find((id) => pins[id] !== undefined);
  return pinned === undefined ? null : pins[pinned]!;
}

/** The pins with every id of `ids` set to `backend`, or cleared when it is null. */
export function withPin(
  pins: Readonly<Record<string, string>>,
  ids: readonly string[],
  backend: string | null,
): Record<string, string> {
  const out = { ...pins };
  for (const id of ids) {
    if (backend === null) delete out[id];
    else out[id] = backend;
  }
  return out;
}

/** Pin a person to one protocol, or release the pin with null. Interactive use only. */
export function peoplePin(ids: readonly string[], backend: string | null, path = configPath()): void {
  const config = loadConfig(path);
  config.pins = withPin(config.pins, ids, backend);
  saveConfig(config, path);
}
