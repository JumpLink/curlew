/**
 * The list's selection mode, with no widget in sight: what the header says and which tools the
 * bottom bar offers for the rows picked (docs/design/contacts.md, "Selection mode").
 */

import { _n, fmt } from '@curlew/protocol';

import { type ListEntry, protocolLabel } from './conversation-list-model.ts';

/** The header while rows are picked: "2 selected", de "2 ausgewählt". */
export function selectionTitle(count: number): string {
  return fmt(_n('{count} selected', '{count} selected', count), { count });
}

/** What the bottom bar may do with the picked rows. */
export interface SelectionTools {
  /** Two or more people, and nothing that is not a person (a group, the note to self). */
  canMerge: boolean;
  /** At least one picked row was merged by hand; unmerging undoes that grouping. */
  canUnmerge: boolean;
  /** Every directory participant the picked rows stand for. */
  personIds: string[];
}

export function selectionTools(picked: readonly ListEntry[]): SelectionTools {
  const personIds = [...new Set(picked.flatMap((entry) => entry.personIds))].sort();
  const allPeople = picked.length > 0 && picked.every((entry) => entry.personIds.length > 0);
  return {
    canMerge: allPeople && picked.length >= 2,
    canUnmerge: picked.some((entry) => entry.manual),
    personIds,
  };
}

/** One line per picked person for the confirmation: the name, then the networks it joins. */
export function mergeSummary(picked: readonly ListEntry[]): string[] {
  return picked.map((entry) => {
    const carriers = entry.members.length > 0 ? entry.members : [entry];
    const networks = [...new Set(carriers.map((c) => protocolLabel(c.backend)))].sort();
    return `${entry.title} (${networks.join(' · ')})`;
  });
}

/** Toggle `id` in `picked`; the same set is returned for chaining. */
export function togglePick(picked: Set<string>, id: string): Set<string> {
  if (picked.has(id)) picked.delete(id);
  else picked.add(id);
  return picked;
}

/** Ids that no longer exist in the list drop out, so a refresh never leaves a phantom pick. */
export function prunePicks(picked: Set<string>, entries: readonly ListEntry[]): void {
  const ids = new Set(entries.map((entry) => entry.id));
  for (const id of picked) if (!ids.has(id)) picked.delete(id);
}
