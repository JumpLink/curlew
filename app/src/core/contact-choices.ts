/**
 * How a contact looks, as the person chose it: the pure rules behind `config.contactChoices`.
 * Kept apart from the config file's I/O so the list can apply them without touching the disk.
 */

import type { ContactChoice } from './config.ts';
import type { AccentName, BackgroundChoice, Look } from './lib/appearance.ts';

export type ContactChoices = Readonly<Record<string, ContactChoice>>;

/** What to change in a contact's choice: a value sets, null clears, undefined keeps. */
export interface ChoicePatch {
  title?: string | null;
  name?: string | null;
  picture?: string | null;
  own?: string | null;
  primary?: AccentName | null;
  accent?: AccentName | null;
  background?: BackgroundChoice | null;
}

/** The key a group's choice is stored under: groups have no participant set, the chat id is stable. */
export const groupKey = (conversationId: string): string => `group:${conversationId}`;

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
  const set = <K extends keyof ContactChoice>(field: K, value: ContactChoice[K] | null | undefined): void => {
    if (value === null) delete next[field];
    else if (value !== undefined) next[field] = value;
  };
  for (const field of ['title', 'name', 'picture', 'own'] as const) set(field, patch[field]);
  for (const field of ['primary', 'accent', 'background'] as const) set(field, patch[field]);
  const out = { ...choices };
  for (const id of ids) delete out[id];
  if (Object.keys(next).length > 0) out[key] = next;
  return out;
}

/** The part of a choice that gives a chat its own colours and pattern. */
export function lookOf(choice: ContactChoice | undefined): Look {
  return {
    ...(choice?.primary !== undefined ? { primary: choice.primary } : {}),
    ...(choice?.accent !== undefined ? { accent: choice.accent } : {}),
    ...(choice?.background !== undefined ? { background: choice.background } : {}),
  };
}
