/**
 * How a contact looks, as the person chose it: the pure rules behind `config.contactChoices`.
 * Kept apart from the config file's I/O so the list can apply them without touching the disk.
 */

import type { ContactChoice } from './config.ts';

export type ContactChoices = Readonly<Record<string, ContactChoice>>;

/** What to change in a contact's choice: a value sets, null clears, undefined keeps. */
export interface ChoicePatch {
  name?: string | null;
  picture?: string | null;
  own?: string | null;
}

/** The key a contact's choice is stored under: the smallest participant id of its person set. */
export const choiceKey = (ids: readonly string[]): string | null => [...ids].sort()[0] ?? null;

/**
 * The choice that belongs to a contact. Any id of its person set may carry it, the smallest
 * first, so a choice made for one person survives a later merge with another.
 */
export function choiceFor(
  choices: ContactChoices,
  ids: readonly string[],
): { key: string; choice: ContactChoice } | null {
  for (const key of [...ids].sort()) {
    const choice = choices[key];
    if (choice !== undefined) return { key, choice };
  }
  return null;
}

/** The choices with `patch` applied to the contact, stored under its smallest id alone. */
export function withChoice(
  choices: ContactChoices,
  ids: readonly string[],
  patch: ChoicePatch,
): Record<string, ContactChoice> {
  const key = choiceKey(ids);
  if (key === null) return { ...choices };
  const next: ContactChoice = { ...choiceFor(choices, ids)?.choice };
  for (const field of ['name', 'picture', 'own'] as const) {
    const value = patch[field];
    if (value === null) delete next[field];
    else if (value !== undefined) next[field] = value;
  }
  const out = { ...choices };
  for (const id of ids) delete out[id];
  if (Object.keys(next).length > 0) out[key] = next;
  return out;
}
